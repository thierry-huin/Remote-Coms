const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const ms = require('../services/mediasoup-manager');

const clients = new Map(); // peerId -> { ws, role, user, streamOnly }
let peerSeq = 0;

// Channel lock: streamId -> { peerId, user }
const channelOwners = new Map();

// Guest-link key per stream: streamId -> random key, generated once the
// FIRST time that stream ever publishes video and kept for as long as this
// backend process runs (never rotated on reconnects/republishes, never
// deleted on unpublish). This is deliberate: the link is meant to work for
// anyone who has it, regardless of which operator/session is currently
// running that stream, and to survive normal reconnects -- the key itself
// is long/random enough that it isn't guessable, so there's no need to
// rotate it defensively. Whether the link currently "does anything" is
// instead driven by whether the stream is actually live right now (see
// 'authGuest' and filterStreamsFor below), not by the key's existence.
const streamGuestKeys = new Map();

function getStreamGuestLink(streamId) {
  return streamGuestKeys.get(streamId) || null;
}

// Admin "New Link": overwrite a stream's guest key with a fresh random one.
// Does NOT touch any already-connected guest session (authGuest only checks
// the key at connect time) -- it just makes the OLD link stop working for
// any *future* connection attempt. Pair with disconnectGuest (below) to also
// kick whoever is already connected with the old link right now.
function regenerateStreamGuestLink(streamId) {
  const key = crypto.randomBytes(9).toString('base64url');
  streamGuestKeys.set(streamId, key);
  return key;
}

// HLS link key per stream -- same "unguessable, generated once on first
// publish, never rotates on its own" model as streamGuestKeys above, kept in
// a SEPARATE map so the two links can be rotated independently. Also used to
// namespace the actual HLS segment directory (see hls-manager.js's startHls)
// so the URL alone never leaks the human-readable streamId.
const streamHlsKeys = new Map();

function getStreamHlsLink(streamId) {
  return streamHlsKeys.get(streamId) || null;
}

function regenerateStreamHlsLink(streamId) {
  const key = crypto.randomBytes(9).toString('base64url');
  streamHlsKeys.set(streamId, key);
  return key;
}

// Guests (viewers connected via a "?s=...&k=..." link, see authGuest) that
// are currently attached to a given stream -- used by the admin panel to
// list + disconnect them individually (see disconnectGuest below).
function getStreamGuestPeers(streamId) {
  const guests = [];
  for (const [id, c] of clients) {
    if (c.streamOnly === streamId) guests.push({ peerId: id, user: c.user });
  }
  return guests;
}

// Attaches each stream's currently-connected guest peers (see
// getStreamGuestPeers) to the plain getActiveStreams() result -- used by
// every place that sends a 'streams' payload, so the admin panel always has
// an up to date list to render its per-stream Disconnect buttons from.
function withGuestPeers(streams) {
  return streams.map((s) => ({ ...s, guests: getStreamGuestPeers(s.streamId) }));
}

// Whether (peerRole, peerUser) may manage stream `streamId`'s admin-style
// controls (PGM volume, private talk, Talkback listen, disconnect guest) or
// its guest link. admin/superadmin can always manage every stream. A
// 'publisher' ( = "streamer" account) can see every stream (that's just
// plain GET /api/streams / the WS 'streams' push, unrestricted by role) but
// may only MANAGE the one it is CURRENTLY the live owner of -- see
// channelOwners, set by 'createPlainTransport' the moment that publisher's
// own tools/publish.js starts streaming, and cleared the moment it stops.
// Never someone else's channel, even while it's live.
function canManageStream(streamId, peerRole, peerUser) {
  if (['admin', 'superadmin'].includes(peerRole)) return true;
  if (peerRole !== 'publisher') return false;
  const owner = channelOwners.get(streamId);
  return !!owner && owner.user === peerUser;
}

function setupSignaling(wss, jwtSecret) {
  const pingInterval = setInterval(() => {
    for (const [id, client] of clients) {
      if (client.ws.readyState !== 1) { clients.delete(id); continue; }
      if (client.ws._dead) { client.ws.close(); continue; }
      client.ws._dead = true;
      client.ws.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(pingInterval));

  // Relay to the publisher whenever the active PGM/Talkback producer for its stream changes,
  // so it can (re)consume the current producer via consumeReturn.
  ms.events.on('returnProducerChanged', ({ streamId, kind, slot }) => {
    const owner = channelOwners.get(streamId);
    if (owner) {
      const client = clients.get(owner.peerId);
      if (client) send(client.ws, { type: 'returnProducerChanged', streamId, kind, slot });
    }

    // PGM "cross-monitor": also tell every OTHER currently-active PGM speaker on this
    // stream that this slot changed (took a producer, or just lost one), so each of
    // them can request/drop a consumePgmPeer for it and hear each other. Talkback
    // stays private/single-speaker -- no cross-monitor for it.
    if (kind === 'pgm' && Number.isInteger(slot)) {
      for (const { peerId: otherPeerId, slot: otherSlot } of ms.getActivePgmSlots(streamId)) {
        if (otherSlot === slot) continue; // don't tell a speaker about their own slot
        const otherClient = clients.get(otherPeerId);
        if (otherClient) send(otherClient.ws, { type: 'pgmPeerChanged', streamId, slot });
      }
      // Admin/publisher PGM "listen" (see togglePgmListen in viewer.js):
      // admins/superadmins AND a publisher monitoring their OWN stream (see
      // canManageStream) are never active PGM speakers themselves (blocked,
      // see 'produceReturn'), so they're never included in getActivePgmSlots
      // above -- push this to all of them too, so whichever one is
      // currently monitoring this stream's PGM can (re)consume the slot that
      // just came or went.
      for (const c of clients.values()) {
        if (c.ws.readyState === 1 && canManageStream(streamId, c.role, c.user)) {
          send(c.ws, { type: 'pgmPeerChanged', streamId, slot });
        }
      }
    }
  });

  // Push per-slot PGM audio levels to whoever may manage this stream (see
  // canManageStream: admin/superadmin for any stream, or its own publisher),
  // so the admin panel can render a VU meter per active speaker without
  // routing their audio to the viewing browser.
  ms.events.on('pgmLevels', ({ streamId, levels }) => {
    const msg = JSON.stringify({ type: 'pgmLevels', streamId, levels });
    for (const c of clients.values()) {
      if (c.ws.readyState === 1 && canManageStream(streamId, c.role, c.user)) c.ws.send(msg);
    }
  });

  // A PGM slot was taken or freed (see produceReturnAudio's producer.observer
  // 'close' handler in mediasoup-manager.js, which fires on EVERY close path --
  // explicit stop, replaced-by-a-new-speaker, AND viewer disconnect/cleanupPeer).
  // Without this, a freed slot never got pushed to connected clients: the admin
  // panel's PGM list kept showing a disconnected speaker as still "occupying"
  // their slot until some UNRELATED broadcastStreams() call happened to fire.
  ms.events.on('pgmSlotsChanged', () => broadcastStreams());

  // Talkback push-to-talk state (who's on it, and whether they're actively
  // speaking right now) changed -- a lightweight streams re-broadcast for the
  // admin panel's green light, NOT a 'returnProducerChanged' relay (that
  // would make the publisher pointlessly re-consume/relink on every single
  // press/release, see setReturnProducerPaused). ALSO tells every connected
  // admin/superadmin to (re)consume this stream's Talkback audio on their own
  // recvTransport (see consumeTalkbackAudio) -- this is the viewer -> admin
  // reply path, fully independent of the publisher's own consumeReturnAudio.
  ms.events.on('talkbackStateChanged', ({ streamId, active }) => {
    broadcastStreams();
    if (streamId) {
      const msg = JSON.stringify({ type: 'talkbackAudioChanged', streamId, active: !!active });
      for (const c of clients.values()) {
        if (c.ws.readyState === 1 && canManageStream(streamId, c.role, c.user)) c.ws.send(msg);
      }
    }
  });

  // Admin -> viewer private talk: relay to the TARGET viewer (identified by
  // peerId, not by slot) whenever an admin starts/stops talking to them.
  ms.events.on('adminTalkChanged', ({ targetPeerId, active, producerId }) => {
    const client = clients.get(targetPeerId);
    if (client) send(client.ws, { type: 'adminTalkChanged', active, producerId });
  });

  // Guest -> guest private PTT talk: relay to the TARGET viewer (identified
  // by peerId) whenever a fellow commentator starts/stops talking to them.
  ms.events.on('peerTalkChanged', ({ targetPeerId, active, producerId }) => {
    const client = clients.get(targetPeerId);
    if (client) send(client.ws, { type: 'peerTalkChanged', active, producerId });
  });

  // Publisher toggled the "On Air" indicator (button next to Play/Stop in the
  // GUI, see installer/video_publisher.py) -- just a plain streams
  // re-broadcast, since getActiveStreams() already reports onAir per stream
  // and every viewer (admin + guest links) needs to see it right away.
  ms.events.on('onAirChanged', () => broadcastStreams());

  wss.on('connection', (ws) => {
    let peerId = null;
    let peerRole = null;
    let peerUser = null;
    let peerStreamOnly = null;
    ws.on('pong', () => { ws._dead = false; });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      try {
        await handleMessage(ws, msg, jwtSecret,
          () => ({ peerId, peerRole, peerUser, peerStreamOnly }),
          (id, role, user, streamOnly) => { peerId = id; peerRole = role; peerUser = user; peerStreamOnly = streamOnly || null; });
      } catch (err) {
        console.error(`[WS] Error (peer=${peerId}, type=${msg.type}):`, err.message);
        send(ws, { type: 'error', requestId: msg.requestId, error: err.message });
      }
    });

    ws.on('close', () => {
      if (peerId) {
        if (ws._streamId) {
          ms.unpublishStream(ws._streamId);
          channelOwners.delete(ws._streamId);
          broadcastChannelStatus();
          console.log(`[Signaling] Publisher disconnected: ${peerId} stream=${ws._streamId}`);
        } else {
          console.log(`[Signaling] Viewer disconnected: ${peerId}`);
        }
        ms.cleanupPeer(peerId);
        clients.delete(peerId);
        broadcastViewerCount();
        // Belt-and-suspenders alongside the 'pgmSlotsChanged' listener above:
        // cleanupPeer() may have just closed this viewer's PGM/Talkback producer
        // (or unpublishStream just closed the publisher's stream) -- make sure
        // every connected client (admin panel, other viewers) gets the
        // refreshed stream/pgmSlots list right away.
        broadcastStreams();
      }
    });
  });
}

async function handleMessage(ws, msg, jwtSecret, getPeer, setPeer) {
  const { peerId, peerRole, peerUser, peerStreamOnly } = getPeer();

  switch (msg.type) {
    case 'auth': {
      const token = msg.token;
      if (!token) { send(ws, { type: 'auth_error', error: 'Token required' }); break; }
      let decoded;
      try { decoded = jwt.verify(token, jwtSecret); } catch {
        send(ws, { type: 'auth_error', error: 'Invalid token' }); break;
      }
      const role = decoded.role || 'viewer';
      const user = decoded.user || 'unknown';
      const prefix = (msg.intent === 'publish') ? 'pub' : 'viewer';
      const id = `${prefix}-${++peerSeq}`;
      setPeer(id, role, user, null);
      clients.set(id, { ws, role, user, streamOnly: null });
      send(ws, { type: 'auth_ok', peerId: id, role });
      send(ws, { type: 'streams', streams: withGuestPeers(ms.getActiveStreams()) });
      send(ws, { type: 'channelStatus', channels: getChannelStatus() });
      broadcastViewerCount();
      console.log(`[Signaling] ${prefix} connected: ${id} (${user}, role=${role})`);
      break;
    }

    case 'authGuest': {
      // Passwordless viewer link scoped to exactly one stream, e.g. for
      // commentators who shouldn't have to deal with accounts/tokens. The
      // key itself (streamGuestKeys) is permanent per streamId once issued;
      // whether the link actually does anything right now depends on the
      // stream being live (checked below), not on the key's existence.
      const { streamId, key } = msg;
      if (!streamId || !key) { send(ws, { type: 'auth_error', error: 'streamId and key required' }); break; }
      const expected = streamGuestKeys.get(streamId);
      if (!expected || expected !== key) {
        send(ws, { type: 'auth_error', error: 'Invalid link' });
        break;
      }
      if (!ms.getActiveStreams().some((s) => s.streamId === streamId)) {
        send(ws, { type: 'auth_error', error: 'Stream is not currently live' });
        break;
      }
      const id = `guest-${++peerSeq}`;
      const user = `guest:${streamId}`;
      setPeer(id, 'viewer', user, streamId);
      clients.set(id, { ws, role: 'viewer', user, streamOnly: streamId });
      send(ws, { type: 'auth_ok', peerId: id, role: 'viewer' });
      send(ws, { type: 'streams', streams: withGuestPeers(filterStreamsFor(streamId, ms.getActiveStreams())) });
      send(ws, { type: 'channelStatus', channels: getChannelStatus() });
      broadcastViewerCount();
      console.log(`[Signaling] guest connected: ${id} (stream=${streamId})`);
      break;
    }

    case 'createPlainTransport': {
      if (!peerId) throw new Error('Not authenticated');
      if (!['publisher', 'admin', 'superadmin'].includes(peerRole))
        throw new Error('Publish permission denied');
      const streamId = msg.streamId || `stream-${Date.now()}`;
      const owner = channelOwners.get(streamId);
      if (owner && owner.peerId !== peerId)
        throw new Error(`Channel ${streamId} locked by ${owner.user}`);
      const result = await ms.createPlainTransport(streamId);
      // Store video and audio transports separately
      if (!ws._transports) ws._transports = {};
      if (msg.kind === 'audio') {
        ws._transports.audio = result.transport;
      } else {
        ws._transports.video = result.transport;
        ws._streamId = streamId;
        channelOwners.set(streamId, { peerId, user: peerUser });
        if (!streamGuestKeys.has(streamId)) {
          streamGuestKeys.set(streamId, crypto.randomBytes(9).toString('base64url'));
        }
        if (!streamHlsKeys.has(streamId)) {
          streamHlsKeys.set(streamId, crypto.randomBytes(9).toString('base64url'));
        }
        broadcastChannelStatus();
      }
      send(ws, {
        type: 'plainTransportCreated', requestId: msg.requestId,
        streamId, ip: result.ip, port: result.port, rtcpPort: result.rtcpPort,
      });
      break;
    }

    case 'produce': {
      const transport = (msg.kind === 'audio') ? ws._transports?.audio : ws._transports?.video;
      if (!transport) throw new Error(`No PlainTransport for ${msg.kind || 'video'}`);
      const result = await ms.publishStream(ws._streamId, {
        transport,
        kind: msg.kind || 'video',
        rtpParameters: msg.rtpParameters,
        metadata: { user: peerUser, ...(msg.metadata || {}) },
      });
      send(ws, { type: 'produced', requestId: msg.requestId, ...result });
      broadcastStreams();
      break;
    }

    case 'unpublish': {
      // BUGFIX: this used to accept an arbitrary msg.streamId with NO
      // ownership check at all -- ANY connected client (including a plain
      // 'viewer', guest link, etc.) could kill ANY other publisher's stream
      // just by naming it. The legitimate publisher never actually sends
      // this message anyway (see tools/publish.js) -- it relies on the
      // ws.on('close') cleanup when the process exits -- so only ever allow
      // it for the stream THIS socket itself owns.
      if (!ws._streamId) throw new Error('Only the stream publisher can unpublish it');
      const sid = ws._streamId;
      ms.unpublishStream(sid); channelOwners.delete(sid); broadcastChannelStatus();
      send(ws, { type: 'unpublished', requestId: msg.requestId, streamId: sid });
      broadcastStreams();
      break;
    }

    case 'getRouterRtpCapabilities':
      send(ws, { type: 'routerRtpCapabilities', requestId: msg.requestId,
        rtpCapabilities: ms.getRouterRtpCapabilities() });
      break;

    case 'setRtpCapabilities':
      ms.setPeerRtpCapabilities(peerId, msg.rtpCapabilities);
      send(ws, { type: 'ok', requestId: msg.requestId });
      break;

    case 'createWebRtcTransport': {
      if (!peerId) throw new Error('Not authenticated');
      const params = await ms.createWebRtcTransport(peerId);
      send(ws, { type: 'transportCreated', requestId: msg.requestId, ...params, iceServers: getIceServers() });
      break;
    }

    case 'createSendTransport': {
      if (!peerId) throw new Error('Not authenticated');
      const params = await ms.createSendTransport(peerId);
      send(ws, { type: 'sendTransportCreated', requestId: msg.requestId, ...params, iceServers: getIceServers() });
      break;
    }

    case 'createReturnTransport': {
      if (!peerId) throw new Error('Not authenticated');
      if (!ws._streamId) throw new Error('Only the stream publisher can create return-audio transports');
      if (!['pgm', 'talkback'].includes(msg.kind)) throw new Error('Invalid return kind');
      const params = await ms.createReturnRecvTransport(peerId, msg.kind);
      send(ws, { type: 'returnTransportCreated', requestId: msg.requestId, kind: msg.kind, ...params, iceServers: getIceServers() });
      break;
    }

    case 'connectTransport':
      if (!peerId) throw new Error('Not authenticated');
      await ms.connectTransport(peerId, msg.transportId, msg.dtlsParameters);
      send(ws, { type: 'ok', requestId: msg.requestId });
      break;

    case 'produceReturn': {
      if (!peerId) throw new Error('Not authenticated');
      if (ws._streamId) throw new Error('Publishers cannot produce return audio');
      if (!['pgm', 'talkback'].includes(msg.kind)) throw new Error('Invalid return kind');
      // PGM and Talkback can ONLY be used from a guest link (peerStreamOnly is
      // only set by 'authGuest', never by a normal 'auth' login) -- this covers
      // regular viewers AND admins/superadmins, who manage PGM (volume, and
      // talking privately to a slot's occupant, see 'produceAdminTalk' below)
      // but must never occupy a PGM/Talkback slot themselves. Enforced
      // server-side, not just by hiding the Mic/Talkback buttons client-side.
      if (!peerStreamOnly) {
        throw new Error('PGM/Talkback solo está disponible vía enlace de invitado');
      }
      // For PGM, let the viewer's own chosen display name ("Tu nombre" field in
      // web/index.html) override the account/guest-link label shown in the admin
      // panel's per-slot list. This matters because peerUser is the same generic
      // "guest:<streamId>" string for every holder of a given guest link, and
      // multiple commentators may also share one login account.
      const displayName = typeof msg.displayName === 'string' ? msg.displayName.trim().slice(0, 30) : '';
      const user = displayName || peerUser;
      const result = await ms.produceReturnAudio(peerId, msg.streamId, msg.kind, msg.rtpParameters, user);
      send(ws, { type: 'returnProduced', requestId: msg.requestId, kind: msg.kind, ...result });
      broadcastStreams();
      break;
    }

    case 'consumeReturn': {
      if (!peerId) throw new Error('Not authenticated');
      if (!ws._streamId || ws._streamId !== msg.streamId)
        throw new Error('Only the stream publisher can consume its own return audio');
      if (!['pgm', 'talkback'].includes(msg.kind)) throw new Error('Invalid return kind');
      const result = await ms.consumeReturnAudio(peerId, msg.streamId, msg.kind, msg.slot);
      send(ws, { type: 'returnConsumed', requestId: msg.requestId, kind: msg.kind, ...(result || { empty: true }) });
      break;
    }

    case 'consumePgmPeer': {
      // PGM "cross-monitor" (a viewer who is themselves an active PGM speaker
      // hearing ANOTHER slot on the same stream) AND admin/publisher PGM
      // "listen" (passively monitoring one stream's PGM, see togglePgmListen
      // in viewer.js -- a publisher only their OWN stream, see
      // canManageStream) both share this same request, consuming over their
      // own recvTransport. A guest link may only ever touch its own scoped
      // stream, same restriction as 'subscribe'.
      if (!peerId) throw new Error('Not authenticated');
      if (peerStreamOnly) {
        if (msg.streamId !== peerStreamOnly) throw new Error('This link only grants access to one specific stream');
      } else if (!canManageStream(msg.streamId, peerRole, peerUser)) {
        throw new Error('Permission denied');
      }
      const result = await ms.consumePgmPeerAudio(peerId, msg.streamId, msg.slot);
      send(ws, { type: 'pgmPeerConsumed', requestId: msg.requestId, slot: msg.slot, ...(result || { empty: true }) });
      break;
    }

    case 'produceAdminTalk': {
      // Admin -> viewer private talk: the admin's own mic, targeting either
      // one PGM slot's current occupant (msg.slot is a number) or every
      // active occupant on the stream at once (msg.slot === 'all', see the
      // panel's "Hablar a los 3" button) -- see mediasoup-manager.js's
      // produceAdminTalk.
      if (!peerId) throw new Error('Not authenticated');
      if (!canManageStream(msg.streamId, peerRole, peerUser)) throw new Error('Permission denied');
      const result = await ms.produceAdminTalk(peerId, msg.streamId, msg.slot, msg.rtpParameters);
      send(ws, { type: 'adminTalkProduced', requestId: msg.requestId, ...result });
      break;
    }

    case 'consumeAdminTalk': {
      // Called by the TARGET viewer after receiving the 'adminTalkChanged' push.
      if (!peerId) throw new Error('Not authenticated');
      const result = await ms.consumeAdminTalk(peerId);
      send(ws, { type: 'adminTalkConsumed', requestId: msg.requestId, ...(result || { empty: true }) });
      break;
    }

    case 'producePeerTalk': {
      // Guest -> guest push-to-talk: any commentator holding a guest link can
      // talk directly to another currently-active PGM slot's occupant on the
      // SAME stream (see mediasoup-manager.js's producePeerTalk). Scoped to
      // guest links only -- same restriction as PGM/Talkback in 'produceReturn'.
      if (!peerId) throw new Error('Not authenticated');
      if (!peerStreamOnly) throw new Error('El talk entre comentaristas solo está disponible vía enlace de invitado');
      if (peerStreamOnly !== msg.streamId) throw new Error('This link only grants access to one specific stream');
      const result = await ms.producePeerTalk(peerId, msg.streamId, msg.targetSlot, msg.rtpParameters);
      send(ws, { type: 'peerTalkProduced', requestId: msg.requestId, ...result });
      break;
    }

    case 'consumePeerTalk': {
      // Called by the TARGET viewer after receiving the 'peerTalkChanged' push.
      if (!peerId) throw new Error('Not authenticated');
      const result = await ms.consumePeerTalk(peerId);
      send(ws, { type: 'peerTalkConsumed', requestId: msg.requestId, ...(result || { empty: true }) });
      break;
    }

    case 'disconnectGuest': {
      // Admin "Disconnect" button: forcibly close a guest-link viewer's
      // socket right now (see regenerateStreamGuestLink for the complementary
      // "New Link" action, which only blocks *future* reconnections). Reuses
      // the existing ws.on('close', ...) cleanup -- no duplicated logic here.
      if (!peerId) throw new Error('Not authenticated');
      const target = clients.get(msg.peerId);
      if (!target || !target.streamOnly) throw new Error('Invitado no encontrado');
      if (!canManageStream(target.streamOnly, peerRole, peerUser)) throw new Error('Permission denied');
      try { target.ws.terminate(); } catch (_) {}
      send(ws, { type: 'ok', requestId: msg.requestId });
      break;
    }

    case 'forceUnpublish': {
      // Admin "Forzar cierre": kill ONE stream on the server right now,
      // regardless of who owns it -- unlike 'unpublish' above (which only
      // ever lets a publisher close its OWN stream). Separate from a full
      // /api/reset: every other stream/viewer keeps running untouched. Also
      // notifies the owning publisher's socket (if still connected) so its
      // own app can react instead of silently pushing RTP into a transport
      // that no longer exists. Deliberately admin/superadmin ONLY (unlike
      // the other actions below, NOT extended to a publisher via
      // canManageStream) -- forcibly killing a stream is more destructive
      // than adjusting its own PGM/Talkback/link, and a publisher can always
      // just stop its own stream normally instead.
      if (!peerId) throw new Error('Not authenticated');
      if (!['admin', 'superadmin'].includes(peerRole)) throw new Error('Permission denied');
      const targetStreamId = msg.streamId;
      if (!targetStreamId) throw new Error('streamId required');
      const owner = channelOwners.get(targetStreamId);
      if (owner) {
        const ownerClient = clients.get(owner.peerId);
        if (ownerClient) send(ownerClient.ws, { type: 'forceStopped', streamId: targetStreamId, by: peerUser });
      }
      ms.unpublishStream(targetStreamId);
      channelOwners.delete(targetStreamId);
      broadcastChannelStatus();
      send(ws, { type: 'ok', requestId: msg.requestId });
      broadcastStreams();
      break;
    }

    case 'setOnAir': {
      // Only the stream's own publisher process can toggle its On Air state
      // (see tools/publish.js's 'onair' GUI-stdin command relay).
      if (!peerId) throw new Error('Not authenticated');
      if (!ws._streamId || ws._streamId !== msg.streamId)
        throw new Error('Only the stream publisher can set its own On Air state');
      const result = ms.setOnAir(msg.streamId, !!msg.onAir);
      send(ws, { type: 'ok', requestId: msg.requestId, ...result });
      break;
    }

    case 'setHlsEnabled': {
      // "HLS" checkbox (see installer/video_publisher.py) -- deliberately a
      // PUBLISHER-only action (same restriction as setOnAir above), not an
      // admin one: generating/copying the resulting LINK is a separate,
      // broader permission (see GET /api/streams/:id/hls-link in index.js).
      if (!peerId) throw new Error('Not authenticated');
      if (!ws._streamId || ws._streamId !== msg.streamId)
        throw new Error('Only the stream publisher can enable HLS for its own stream');
      const result = await ms.setHlsEnabled(msg.streamId, !!msg.enabled);
      send(ws, { type: 'ok', requestId: msg.requestId, ...result });
      broadcastStreams();
      break;
    }

    case 'consumeTalkback': {
      // Viewer -> admin Talkback (reverse of produceAdminTalk/consumeAdminTalk
      // above): called by an admin/superadmin after receiving the
      // 'talkbackAudioChanged' push, to hear whichever guest-link viewer is
      // currently holding Talkback on msg.streamId.
      if (!peerId) throw new Error('Not authenticated');
      if (!canManageStream(msg.streamId, peerRole, peerUser)) throw new Error('Permission denied');
      const result = await ms.consumeTalkbackAudio(peerId, msg.streamId);
      send(ws, { type: 'talkbackConsumed', requestId: msg.requestId, ...(result || { empty: true }) });
      break;
    }

    case 'setPgmVolume': {
      if (!peerId) throw new Error('Not authenticated');
      if (!canManageStream(msg.streamId, peerRole, peerUser)) throw new Error('Permission denied');
      const result = ms.setPgmSlotVolume(msg.streamId, msg.slot, msg.volume);
      const owner = channelOwners.get(msg.streamId);
      const ownerClient = owner && clients.get(owner.peerId);
      if (ownerClient) send(ownerClient.ws, { type: 'setPgmVolume', streamId: msg.streamId, slot: result.slot, volume: result.volume });
      send(ws, { type: 'ok', requestId: msg.requestId });
      broadcastStreams();
      break;
    }

    case 'pauseReturn':
    case 'resumeReturn': {
      if (!peerId) throw new Error('Not authenticated');
      if (ws._streamId) throw new Error('Publishers cannot pause/resume return audio');
      if (!['pgm', 'talkback'].includes(msg.kind)) throw new Error('Invalid return kind');
      await ms.setReturnProducerPaused(peerId, msg.kind, msg.type === 'pauseReturn');
      send(ws, { type: 'ok', requestId: msg.requestId });
      break;
    }

    case 'subscribe': {
      if (peerStreamOnly && msg.streamId !== peerStreamOnly)
        throw new Error('This link only grants access to one specific stream');
      const cp = await ms.subscribe(peerId, msg.streamId);
      send(ws, { type: 'subscribed', requestId: msg.requestId, ...cp });
      break;
    }

    case 'resumeConsumer':
      await ms.resumeConsumer(peerId, msg.consumerId);
      send(ws, { type: 'ok', requestId: msg.requestId });
      break;

    case 'enableRist': {
      // Publisher requests RIST relay for a transport -- restrict to the
      // actual owning publisher (same pattern as 'unpublish'/'setOnAir'
      // above), since this spins up a relay process keyed off ws._streamId.
      if (!ws._streamId) throw new Error('Only the stream publisher can enable RIST relay');
      const ristRelay = require('../services/rist-relay');
      const rp = ristRelay.startRelay(`${ws._streamId}-${msg.rtpPort}`, msg.rtpPort);
      send(ws, { type: 'ristEnabled', requestId: msg.requestId, ristPort: rp });
      break;
    }

    case 'getStreams':
      send(ws, { type: 'streams', streams: withGuestPeers(filterStreamsFor(peerStreamOnly, ms.getActiveStreams())) }); break;

    case 'getChannelStatus':
      send(ws, { type: 'channelStatus', channels: getChannelStatus() }); break;

    case 'getStats':
      send(ws, { type: 'stats', requestId: msg.requestId, ...ms.getStats() }); break;

    case 'ping':
      send(ws, { type: 'pong', requestId: msg.requestId }); break;
  }
}

function getChannelStatus() {
  const status = {};
  for (const [streamId, owner] of channelOwners)
    status[streamId] = { locked: true, user: owner.user };
  return status;
}

function filterStreamsFor(streamOnly, streams) {
  if (!streamOnly) return streams;
  return streams.filter((s) => s.streamId === streamOnly);
}

function getIceServers() {
  const iceServers = [];
  const turnHost = process.env.TURN_HOST || process.env.EXTERNAL_IP || '';
  const turnPort = process.env.TURN_PORT || '3478';
  if (turnHost) {
    iceServers.push({ urls: [`stun:${turnHost}:${turnPort}`] });
    iceServers.push({
      urls: [`turn:${turnHost}:${turnPort}?transport=udp`, `turn:${turnHost}:${turnPort}?transport=tcp`],
      username: process.env.TURN_USER || 'intercom',
      credential: process.env.TURN_PASSWORD || 'intercom2024',
    });
  }
  return iceServers;
}

function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }

function broadcastViewerCount() {
  const count = [...clients.values()].filter(c => !c.ws._streamId).length;
  const msg = JSON.stringify({ type: 'viewerCount', count });
  for (const c of clients.values()) if (c.ws.readyState === 1) c.ws.send(msg);
}

function broadcastStreams() {
  const streams = withGuestPeers(ms.getActiveStreams());
  for (const c of clients.values()) {
    if (c.ws.readyState !== 1) continue;
    c.ws.send(JSON.stringify({ type: 'streams', streams: filterStreamsFor(c.streamOnly, streams) }));
  }
}

function broadcastChannelStatus() {
  const msg = JSON.stringify({ type: 'channelStatus', channels: getChannelStatus() });
  for (const c of clients.values()) if (c.ws.readyState === 1) c.ws.send(msg);
}

// Full server reset (see POST /api/reset): ms.resetAll() only tears down
// mediasoup-level resources (producers/transports) -- it has NO knowledge
// of this module's own state (channelOwners, the "who owns which stream"
// locks, and the live `clients` map). Without also clearing those here,
// every streamId that was live before the reset stayed PERMANENTLY locked
// to its old (now-gone) peerId forever after: the publisher app reconnects
// with a brand new peerId (a fresh WS connection), fails the
// createPlainTransport ownership check ("Channel X locked by Y"), and could
// never republish that channel again without restarting the whole backend
// process -- this was the actual cause of "Reset Server no se cerró bien,
// fue imposible volver a hacer un stream". Forcibly terminating every
// connected socket also ensures every client (publishers AND viewers)
// reconnects from a clean slate instead of sitting on a WS connection whose
// mediasoup-side resources just vanished out from under it.
function resetSignaling() {
  channelOwners.clear();
  for (const client of clients.values()) {
    try { client.ws.terminate(); } catch (_) {}
  }
  clients.clear();
}

module.exports = {
  setupSignaling, getStreamGuestLink, regenerateStreamGuestLink,
  getStreamHlsLink, regenerateStreamHlsLink,
  resetSignaling, canManageStream,
};
