const mediasoup = require('mediasoup');
const { EventEmitter } = require('events');
const msConfig = require('../mediasoup-config');
const ristRelay = require('./rist-relay');
const hlsManager = require('./hls-manager');

// Emits 'returnProducerChanged' ({ streamId, kind, slot? }) whenever the active PGM/Talkback
// producer for a stream changes (new producer, or the previous one closed). The publisher
// (tools/publish.js) listens for this (relayed via signaling.js) to (re)consume it.
// Also emits 'pgmSlotsChanged' ({ streamId }) whenever a PGM slot is taken/freed (for admin
// UIs) and 'pgmLevels' ({ streamId, levels }) periodically with per-slot audio levels.
const events = new EventEmitter();

let workers = [];
let workerIdx = 0;
let router = null;

// Active streams: streamId -> { producer, plainTransport, audioProducer, audioTransport, metadata }
const streams = new Map();
// Streams whose owning publisher has ticked the "HLS" checkbox (see
// setHlsEnabled) -- kept SEPARATE from the `streams` map (which gets wiped
// on every unpublish/republish) so the desired state survives a
// stop/republish cycle, e.g. an operator briefly restarting their channel:
// the HLS output comes back on its own against the new Producer, same as
// the guest link "just keeps working" across reconnects.
const hlsWanted = new Set();
// Viewer peers: peerId -> { recvTransport, consumers: Map<consumerId, consumer>, rtpCapabilities }
const peers = new Map();

// Up to this many PGM (Mic) speakers can be live at once per stream -- unlike
// Talkback (still single-speaker, "last one wins"), PGM supports several
// simultaneous commentators, each in their own numbered slot so the admin
// panel can show/adjust them individually.
const PGM_MAX_SLOTS = 3;

// Server-side level metering for PGM speakers (see setPgmSlotVolume/getActiveStreams's
// pgmSlots): lets the admin panel show a VU meter per active speaker WITHOUT routing
// their audio to the admin's browser -- mediasoup measures RTP audio level directly.
let audioLevelObserver = null;
const pgmLevelMeta = new Map(); // producerId -> { streamId, slot }

// ======================== INIT ========================

async function init() {
  for (let i = 0; i < msConfig.numWorkers; i++) {
    const worker = await mediasoup.createWorker(msConfig.worker);
    worker.on('died', () => {
      console.error(`[mediasoup] Worker ${worker.pid} died! Restarting...`);
      setTimeout(() => process.exit(1), 2000);
    });
    workers.push(worker);
    console.log(`[mediasoup] Worker pid=${worker.pid}`);
  }
  const worker = workers[0];
  router = await worker.createRouter({ mediaCodecs: msConfig.router.mediaCodecs });
  console.log(`[mediasoup] Router id=${router.id}`);

  audioLevelObserver = await router.createAudioLevelObserver({
    maxEntries: 30, // generous ceiling: a handful of concurrently-live streams x up to 3 pgm slots each
    threshold: -80,
    interval: 200,
  });
  audioLevelObserver.on('volumes', (volumes) => {
    const byStream = new Map(); // streamId -> Array(PGM_MAX_SLOTS) of dBov|null
    for (const { producer, volume } of volumes) {
      const meta = pgmLevelMeta.get(producer.id);
      if (!meta) continue;
      if (!byStream.has(meta.streamId)) byStream.set(meta.streamId, new Array(PGM_MAX_SLOTS).fill(null));
      byStream.get(meta.streamId)[meta.slot] = volume;
    }
    for (const [streamId, levels] of byStream) {
      events.emit('pgmLevels', { streamId, levels });
    }
  });
}

function getRouter() { return router; }
function getRouterRtpCapabilities() { return router.rtpCapabilities; }

// ======================== PLAIN TRANSPORT (GStreamer ingest) ========================

async function createPlainTransport(streamId) {
  // Close any existing stream on this channel first
  if (streams.has(streamId)) {
    console.log(`[mediasoup] Cleaning up existing stream: ${streamId}`);
    unpublishStream(streamId);
  }

  const announcedIps = (process.env.MEDIASOUP_ANNOUNCED_IPS || '127.0.0.1')
    .split(',').map(s => s.trim()).filter(Boolean);

  const transport = await router.createPlainTransport({
    listenInfo: { protocol: 'udp', ip: '0.0.0.0', announcedAddress: announcedIps[0] },
    rtcpMux: false,
    comedia: true, // auto-detect remote IP/port from first RTP packet
  });

  const rtpPort = transport.tuple.localPort;

  console.log(`[mediasoup] PlainTransport created: stream=${streamId} rtp=${rtpPort}`);

  return {
    transport,
    ip: transport.tuple.localIp,
    port: rtpPort,
    rtcpPort: transport.rtcpTuple?.localPort,
  };
}

const RETURN_KINDS = ['pgm', 'talkback'];

async function publishStream(streamId, { transport, kind, rtpParameters, metadata }) {
  const producer = await transport.produce({ kind, rtpParameters });
  producer.on('transportclose', () => {
    console.log(`[mediasoup] Producer transport closed: stream=${streamId} kind=${kind}`);
  });

  const existing = streams.get(streamId) || {};
  if (kind === 'audio') {
    existing.audioProducer = producer;
    existing.audioTransport = transport;
  } else {
    existing.producer = producer;
    existing.plainTransport = transport;
  }
  existing.metadata = { ...(existing.metadata || {}), ...(metadata || {}) };
  existing.kind = existing.producer ? 'video' : kind;
  streams.set(streamId, existing);

  console.log(`[mediasoup] Stream published: stream=${streamId} kind=${kind} ` +
    `producer=${producer.id}`);

  // The video producer just (re)appeared -- if this stream's publisher had
  // HLS enabled before (e.g. it was toggled on, then the operator did a
  // plain Stop/Play cycle, which gets a brand new Producer), transparently
  // restart HLS against the new Producer instead of leaving it silently
  // stopped until someone re-ticks the checkbox. A restart of just the
  // video ENCODER (the \u23f1 clock-overlay button) never hits this path at
  // all -- it reuses the same local RTP port/Producer, see publish.js.
  if (kind === 'video' && hlsWanted.has(streamId)) {
    _restartHlsFor(streamId).catch((err) =>
      console.error(`[HLS] ${streamId}: auto-restart failed: ${err.message}`));
  }

  return { producerId: producer.id };
}

async function _restartHlsFor(streamId) {
  const stream = streams.get(streamId);
  if (!stream?.producer) return;
  const key = require('../ws/signaling').getStreamHlsLink(streamId);
  if (!key) return; // shouldn't happen (key is created alongside the guest key), but be safe
  await hlsManager.startHls(streamId, router, stream.producer, stream.audioProducer, key);
}

/** Publisher-only toggle (see the "HLS" checkbox in installer/video_publisher.py
 * and the 'setHlsEnabled' WS case in signaling.js, which restricts this to the
 * OWNING publisher connection). Starts/stops the parallel HLS output for this
 * stream (see hls-manager.js); the desired state is remembered in `hlsWanted`
 * so it survives a stop/republish cycle (see publishStream's auto-restart
 * above). */
async function setHlsEnabled(streamId, enabled) {
  if (enabled) {
    hlsWanted.add(streamId);
    await _restartHlsFor(streamId);
  } else {
    hlsWanted.delete(streamId);
    hlsManager.stopHls(streamId);
  }
  return { streamId, hlsEnabled: enabled };
}

function unpublishStream(streamId) {
  const stream = streams.get(streamId);
  if (!stream) return;
  try { stream.producer?.close(); } catch (_) {}
  try { stream.plainTransport?.close(); } catch (_) {}
  try { stream.audioProducer?.close(); } catch (_) {}
  try { stream.audioTransport?.close(); } catch (_) {}
  // Close return-audio producers (PGM/Talkback) — no publisher left to receive them.
  // Closing each producer fires its own 'close' handler (registered in
  // produceReturnAudio), which already does all the slot/peer/observer
  // bookkeeping uniformly, regardless of why the producer closed.
  try { stream.returnProducers?.talkback?.close(); } catch (_) {}
  for (const entry of stream.returnProducers?.pgm || []) {
    if (entry) { try { entry.producer.close(); } catch (_) {} }
  }
  // Stop RIST relays
  ristRelay.stopRelay(`${streamId}-video`);
  ristRelay.stopRelay(`${streamId}-audio`);
  // Stop HLS output too (NOT hlsWanted.delete() -- the desired state stays
  // remembered so it comes back automatically if this stream republishes,
  // see publishStream's auto-restart above; a real full stop leaves the
  // segment directory cleaned up either way, see hlsManager.stopHls).
  hlsManager.stopHls(streamId);
  streams.delete(streamId);
  console.log(`[mediasoup] Stream unpublished: ${streamId}`);
}

function getActiveStreams() {
  const result = [];
  for (const [id, s] of streams) {
    const pgmSlots = Array.isArray(s.returnProducers?.pgm)
      // peerId included so the admin panel can light a per-slot Talkback LED
      // for the exact commentator currently on it (see talkbackPeerId below),
      // rather than matching by (possibly duplicate/blank) display name.
      ? s.returnProducers.pgm.map(entry => entry ? { user: entry.user, volume: entry.volume, peerId: entry.peerId } : null)
      : new Array(PGM_MAX_SLOTS).fill(null);
    result.push({
      streamId: id,
      kind: s.kind,
      producerId: s.producer?.id,
      audioProducerId: s.audioProducer?.id || null,
      paused: s.producer?.paused,
      streamName: s.metadata?.streamName || id,
      hasAudio: !!s.audioProducer,
      metadata: s.metadata,
      pgmSlots,
      talkbackUser: s.talkbackUser || null,
      talkbackActive: !!s.talkbackActive,
      talkbackPeerId: s.talkbackPeerId || null,
      onAir: !!s.onAir,
      hlsEnabled: hlsWanted.has(id),
    });
  }
  return result;
}

/** Publisher-controlled "On Air" indicator (the button next to Play/Stop in
 * the GUI, see installer/video_publisher.py): purely a signal telling
 * commentators/admins they may start speaking now -- has no effect on
 * PGM/Talkback permissions or audio routing, it's just state that gets
 * broadcast to every viewer (see 'onAirChanged' -> broadcastStreams in
 * signaling.js) so they can show/hide a red "ON AIR" box on their screen. */
function setOnAir(streamId, onAir) {
  const stream = streams.get(streamId);
  if (!stream) throw new Error(`Stream not found: ${streamId}`);
  stream.onAir = !!onAir;
  events.emit('onAirChanged', { streamId, onAir: stream.onAir });
  return { streamId, onAir: stream.onAir };
}

// ======================== WEBRTC TRANSPORT (viewers) ========================

async function _newWebRtcTransport(label) {
  const announcedIps = (process.env.MEDIASOUP_ANNOUNCED_IPS || '127.0.0.1')
    .split(',').map(s => s.trim()).filter(Boolean);

  const listenInfos = [];
  for (const ip of announcedIps) {
    listenInfos.push({ protocol: 'udp', ip: '0.0.0.0', announcedAddress: ip });
    listenInfos.push({ protocol: 'tcp', ip: '0.0.0.0', announcedAddress: ip });
  }

  const transport = await router.createWebRtcTransport({
    listenInfos,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: msConfig.webRtcTransport.initialAvailableOutgoingBitrate,
  });

  if (msConfig.webRtcTransport.maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(msConfig.webRtcTransport.maxIncomingBitrate);
    } catch (_) {}
  }

  transport.on('dtlsstatechange', (state) => {
    if (state === 'failed' || state === 'closed') {
      console.warn(`[mediasoup] ${label} transport ${state}`);
      transport.close();
    }
  });

  return transport;
}

function _ensurePeer(peerId) {
  let peer = peers.get(peerId);
  if (!peer) {
    peer = { recvTransport: null, sendTransport: null, consumers: new Map(),
             returnProducers: {}, returnRecvTransports: {}, returnConsumers: {},
             // slot -> Consumer, on this SAME peer's recvTransport, for the audio of
             // OTHER active PGM speakers ("cross-monitor" so commentators can hear
             // each other) -- see consumePgmPeerAudio.
             pgmPeerConsumers: new Map(),
             // Admin -> viewer private talk (see produceAdminTalk/consumeAdminTalk):
             // adminTalkProducer is set on the ADMIN's own peer object (their outgoing
             // mic, targeting one PGM slot's occupant OR every active occupant at once,
             // see targetPeerIds); adminTalkConsumer is set on the TARGET viewer's peer
             // object (what they consume/play back).
             adminTalkProducer: null, adminTalkConsumer: null,
             // Guest -> guest private PTT talk (see producePeerTalk/consumePeerTalk):
             // same shape as the admin -> viewer talk above, just peer-to-peer and
             // always a single target (no 'all' fan-out) -- peerTalkProducer is set
             // on the CALLER's own peer object, peerTalkConsumer on the TARGET's.
             peerTalkProducer: null, peerTalkConsumer: null,
             // Viewer -> admin Talkback (reverse direction, see consumeTalkbackAudio):
             // streamId -> Consumer, on this ADMIN peer's OWN recvTransport, for
             // whichever viewer is currently holding Talkback on that stream. This is
             // fully independent of/additional to the publisher's own consumeReturnAudio
             // ('talkback' kind) -- a Producer can feed multiple simultaneous Consumers,
             // so the publisher's technician (if any) and any connected admin browser can
             // both hear the SAME Talkback audio at once.
             talkbackConsumers: new Map(),
             rtpCapabilities: null };
    peers.set(peerId, peer);
  }
  return peer;
}

/** Active PGM slots for a stream, as [{ slot, peerId }], for notifying/cross-monitoring
 * purposes (see consumePgmPeerAudio and its 'pgmPeerChanged' relay in signaling.js). */
function getActivePgmSlots(streamId) {
  const stream = streams.get(streamId);
  const slots = stream?.returnProducers?.pgm;
  if (!Array.isArray(slots)) return [];
  const result = [];
  slots.forEach((entry, slot) => { if (entry) result.push({ slot, peerId: entry.peerId }); });
  return result;
}

async function createWebRtcTransport(peerId) {
  const transport = await _newWebRtcTransport(`Viewer recv (peer=${peerId})`);
  const peer = _ensurePeer(peerId);
  peer.recvTransport = transport;

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

// ======================== RETURN AUDIO (viewer mic <-> publisher, NAT-safe via WebRTC/TURN) ========================
// The viewer's mic is produced over its own WebRTC send transport (below). The publisher
// consumes it as a regular WebRTC peer too (tools/return-audio-receiver.py), traversing any
// NAT via the same TURN server used by browser viewers. No PlainTransport/fixed ports involved.

async function createSendTransport(peerId) {
  const transport = await _newWebRtcTransport(`Viewer send (peer=${peerId})`);
  const peer = _ensurePeer(peerId);
  peer.sendTransport = transport;

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

/**
 * A publisher (tools/return-audio-receiver.py) gets its OWN independent WebRTC
 * transport per return-audio kind (pgm/talkback) — NOT a shared/bundled one.
 * This is deliberate: GStreamer's webrtcbin cannot reliably demux 2 recvonly
 * transceivers that share one bundled transport when both use the same codec
 * (observed in practice: packets randomly attributed to the wrong transceiver
 * regardless of mid/mlineindex). Two fully separate ICE/DTLS sessions remove
 * the ambiguity entirely, at the cost of one extra ICE handshake.
 */
async function createReturnRecvTransport(peerId, kind) {
  if (!RETURN_KINDS.includes(kind)) throw new Error(`Invalid return kind: ${kind}`);
  const transport = await _newWebRtcTransport(`Publisher return-recv ${kind} (peer=${peerId})`);
  const peer = _ensurePeer(peerId);
  peer.returnRecvTransports[kind] = transport;

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

async function produceReturnAudio(peerId, streamId, kind, rtpParameters, user) {
  if (!RETURN_KINDS.includes(kind)) throw new Error(`Invalid return kind: ${kind}`);
  const peer = peers.get(peerId);
  if (!peer?.sendTransport) throw new Error(`No send transport for peer=${peerId}`);
  const stream = streams.get(streamId);
  if (!stream) throw new Error(`Stream not found: ${streamId}`);
  if (!stream.returnProducers) stream.returnProducers = {};

  if (kind === 'talkback') {
    // Talkback stays single-speaker, "last one wins": only ever one private
    // line to the publisher's technician, no need for multiple slots.
    const previous = peer.returnProducers.talkback;
    if (previous) { try { previous.producer.close(); } catch (_) {} }

    // A DIFFERENT peer may already be producing talkback for this stream (e.g.
    // switching viewer/browser mid-session). "Last producer wins" must also mean
    // the old one gets closed, otherwise both keep sending RTP and the publisher's
    // single webrtcbin ends up with two producers' media colliding on the same
    // transport (observed as GStreamer "not-linked"/ICE-failed errors).
    const oldStreamProducer = stream.returnProducers.talkback;

    const producer = await peer.sendTransport.produce({ kind: 'audio', rtpParameters });
    peer.returnProducers.talkback = { producer, streamId };
    stream.returnProducers.talkback = producer;
    // Who's currently on Talkback (for the admin panel's green light, see
    // getActiveStreams) and whether they're ACTUALLY speaking right now
    // (resumed) vs just holding an idle/paused producer -- distinct from mere
    // producer existence since push-to-talk (see viewer.js's startTalkback/
    // stopTalkback) pauses/resumes this SAME producer on every press/release
    // rather than recreating it. Starts false: the client always creates the
    // producer paused and only resumes it via a separate 'resumeReturn' call
    // (see setReturnProducerPaused) once push-to-talk is actually pressed.
    stream.talkbackUser = user || null;
    stream.talkbackActive = false;
    stream.talkbackPeerId = peerId;

    // IMPORTANT: mediasoup's Producer only emits 'transportclose' on its public
    // EventEmitter interface -- calling producer.close() directly (as cleanupPeer,
    // unpublishStream, resetAll, and the "supersede" logic below all do) emits
    // '@close' instead, which is NOT the same as 'close' and is never delivered
    // to producer.on('close', ...). That silently broke ALL of this cleanup
    // (slot never freed, no returnProducerChanged/pgmSlotsChanged event) on every
    // disconnect/close path, since none of them go through transportClosed().
    // producer.observer.on('close', ...) DOES fire in every case (direct close
    // AND transport close), so use that single hook instead of both events.
    producer.observer.on('close', () => {
      if (peer.returnProducers.talkback?.producer === producer) delete peer.returnProducers.talkback;
      if (stream.returnProducers.talkback === producer) {
        stream.returnProducers.talkback = null;
        stream.talkbackUser = null;
        stream.talkbackActive = false;
        stream.talkbackPeerId = null;
        events.emit('returnProducerChanged', { streamId, kind });
        events.emit('talkbackStateChanged', { streamId, active: false });
      }
    });

    if (oldStreamProducer && oldStreamProducer !== producer && !oldStreamProducer.closed) {
      try { oldStreamProducer.close(); } catch (_) {}
    }

    events.emit('returnProducerChanged', { streamId, kind });
    return { producerId: producer.id };
  }

  // kind === 'pgm': up to PGM_MAX_SLOTS simultaneous speakers per stream, each
  // in their own numbered slot (so the admin panel can show/adjust them
  // individually, see setPgmSlotVolume). A peer that already holds a slot
  // (e.g. re-producing after some client-side reset) keeps that same slot
  // number and volume instead of taking a new one.
  if (!Array.isArray(stream.returnProducers.pgm)) {
    stream.returnProducers.pgm = new Array(PGM_MAX_SLOTS).fill(null);
  }
  const slots = stream.returnProducers.pgm;

  let slot = slots.findIndex((s) => s && s.peerId === peerId);
  if (slot === -1) {
    slot = slots.findIndex((s) => s === null);
    if (slot === -1) throw new Error(`PGM lleno (${PGM_MAX_SLOTS}/${PGM_MAX_SLOTS} activos)`);
  }
  const oldSlotEntry = slots[slot];

  const producer = await peer.sendTransport.produce({ kind: 'audio', rtpParameters });
  peer.returnProducers.pgm = { producer, streamId, slot };
  slots[slot] = {
    producer, peerId, user: user || null,
    volume: (oldSlotEntry && oldSlotEntry.peerId === peerId) ? oldSlotEntry.volume : 1,
  };

  // See the equivalent comment in the talkback branch above: producer.close()
  // (used by cleanupPeer on disconnect, unpublishStream, resetAll, and the
  // "supersede" logic below) never fires producer.on('close', ...) -- that was
  // this feature's actual bug, leaving slots stuck "occupied" forever after a
  // viewer disconnected/closed their browser. producer.observer.on('close', ...)
  // fires reliably for both direct close and transport close.
  producer.observer.on('close', () => {
    if (peer.returnProducers.pgm?.producer === producer) delete peer.returnProducers.pgm;
    if (slots[slot]?.producer === producer) {
      slots[slot] = null;
      pgmLevelMeta.delete(producer.id);
      // NOT audioLevelObserver.removeProducer() here: mediasoup ALREADY removes a
      // Producer from every RtpObserver it was added to as part of closing it
      // (before this 'close' handler even runs), so calling removeProducer()
      // again always rejects with "Producer with id ... not found". That
      // rejection was never awaited/caught (removeProducer is async, and a
      // sync try/catch here can't catch a promise rejection), so it surfaced
      // as an unhandledRejection that crashed the ENTIRE backend process --
      // taking down every stream for every viewer, not just this PGM slot.
      events.emit('returnProducerChanged', { streamId, kind, slot });
      events.emit('pgmSlotsChanged', { streamId });
    }
  });

  // Close the superseded producer (a different peer that used to hold this
  // slot, or this SAME peer's previous producer) AFTER the new one is already
  // registered as current, so its 'close' handler sees slots[slot] !== itself
  // and skips the null-out/duplicate event.
  if (oldSlotEntry && oldSlotEntry.producer !== producer && !oldSlotEntry.producer.closed) {
    try { oldSlotEntry.producer.close(); } catch (_) {}
  }

  pgmLevelMeta.set(producer.id, { streamId, slot });
  if (audioLevelObserver) {
    try { await audioLevelObserver.addProducer({ producerId: producer.id }); } catch (_) {}
  }

  events.emit('returnProducerChanged', { streamId, kind, slot });
  events.emit('pgmSlotsChanged', { streamId });
  return { producerId: producer.id, slot };
}

/** Admin-only: set the mixing volume for one active PGM slot. The actual gain
 * change happens on the publisher (GStreamer mixer, see tools/publish.js's
 * setPgmVolume relay) -- this just records the value so getActiveStreams()
 * can report it back (e.g. when the admin panel re-opens). */
function setPgmSlotVolume(streamId, slot, volume) {
  const stream = streams.get(streamId);
  if (!stream) throw new Error(`Stream not found: ${streamId}`);
  const entry = stream.returnProducers?.pgm?.[slot];
  if (!entry) throw new Error(`No active PGM speaker in slot ${slot}`);
  entry.volume = Math.max(0, Math.min(2, Number(volume)));
  if (!Number.isFinite(entry.volume)) entry.volume = 1;
  return { streamId, slot, volume: entry.volume };
}

/**
 * Called by the publisher (tools/publish.js, via return-audio-receiver.py) to (re)consume
 * the currently active PGM/Talkback producer for its own stream over its recvTransport.
 * For kind='pgm', `slot` (0..PGM_MAX_SLOTS-1) selects which speaker to consume; each slot
 * gets its own independent consumer so the publisher can mix up to 3 simultaneous speakers.
 * Returns null if no viewer is currently producing that kind/slot for this stream.
 */
async function consumeReturnAudio(peerId, streamId, kind, slot) {
  if (!RETURN_KINDS.includes(kind)) throw new Error(`Invalid return kind: ${kind}`);
  const peer = peers.get(peerId);
  const transport = peer?.returnRecvTransports?.[kind];
  if (!transport || !peer.rtpCapabilities) throw new Error(`Peer not ready: ${peerId} (kind=${kind})`);
  const stream = streams.get(streamId);
  if (!stream) throw new Error(`Stream not found: ${streamId}`);

  const producer = kind === 'pgm'
    ? (Number.isInteger(slot) && slot >= 0 && slot < PGM_MAX_SLOTS ? stream.returnProducers?.pgm?.[slot]?.producer : null)
    : stream.returnProducers?.[kind];
  if (kind === 'pgm' && !(Number.isInteger(slot) && slot >= 0 && slot < PGM_MAX_SLOTS)) {
    throw new Error(`Invalid PGM slot: ${slot}`);
  }
  if (!producer || producer.closed) return null;
  if (!router.canConsume({ producerId: producer.id, rtpCapabilities: peer.rtpCapabilities })) {
    throw new Error(`Cannot consume return audio: capability mismatch (kind=${kind})`);
  }

  if (!peer.returnConsumers) peer.returnConsumers = {};
  if (kind === 'pgm' && (typeof peer.returnConsumers.pgm !== 'object' || peer.returnConsumers.pgm === null || Array.isArray(peer.returnConsumers.pgm))) {
    peer.returnConsumers.pgm = {};
  }

  // Close any consumer this publisher already had for this kind (and, for pgm,
  // this specific slot) before adding a new one: each per-kind/per-slot
  // webrtcbin expects exactly ONE incoming media source at a time. Leaving an
  // old consumer open (e.g. after a different viewer/browser takes over a
  // slot) feeds two producers' RTP into the same transport simultaneously.
  const oldConsumer = kind === 'pgm' ? peer.returnConsumers.pgm[slot] : peer.returnConsumers[kind];
  if (oldConsumer && !oldConsumer.closed) {
    try { oldConsumer.close(); } catch (_) {}
  }

  const consumer = await transport.consume({
    producerId: producer.id,
    rtpCapabilities: peer.rtpCapabilities,
    paused: true,
  });
  peer.consumers.set(consumer.id, consumer);
  if (kind === 'pgm') {
    peer.returnConsumers.pgm[slot] = consumer;
  } else {
    peer.returnConsumers[kind] = consumer;
  }
  const forget = () => {
    peer.consumers.delete(consumer.id);
    if (kind === 'pgm') {
      if (peer.returnConsumers.pgm[slot] === consumer) delete peer.returnConsumers.pgm[slot];
    } else if (peer.returnConsumers[kind] === consumer) {
      delete peer.returnConsumers[kind];
    }
  };
  consumer.on('transportclose', forget);
  consumer.on('producerclose', forget);

  console.log(`[mediasoup] Return audio consumed by publisher: stream=${streamId} kind=${kind}${kind === 'pgm' ? ` slot=${slot}` : ''} producer=${producer.id}`);
  return { id: consumer.id, producerId: producer.id, kind: 'audio', rtpParameters: consumer.rtpParameters, slot: kind === 'pgm' ? slot : undefined };
}

/**
 * PGM "cross-monitor": lets an active PGM speaker (peer) hear ANOTHER active
 * PGM speaker on the same stream, by consuming that OTHER slot's producer on
 * the peer's OWN recvTransport (the same one already used for the main
 * video/audio subscription -- no extra transport needed). Never lets a peer
 * consume its own slot (pointless self-echo). Returns null if that slot has
 * no active producer right now (not joined yet, or just left) -- in that
 * case any stale consumer this peer still had for it is also torn down.
 */
async function consumePgmPeerAudio(peerId, streamId, slot) {
  const peer = peers.get(peerId);
  if (!peer?.recvTransport || !peer.rtpCapabilities) throw new Error(`Peer not ready: ${peerId}`);
  if (!Number.isInteger(slot) || slot < 0 || slot >= PGM_MAX_SLOTS) throw new Error(`Invalid PGM slot: ${slot}`);
  const stream = streams.get(streamId);
  if (!stream) throw new Error(`Stream not found: ${streamId}`);

  const ownPgm = peer.returnProducers?.pgm;
  if (ownPgm && ownPgm.streamId === streamId && ownPgm.slot === slot) {
    throw new Error('Cannot cross-monitor your own PGM slot');
  }

  const producer = stream.returnProducers?.pgm?.[slot]?.producer;
  if (!producer || producer.closed) {
    const old = peer.pgmPeerConsumers.get(slot);
    if (old && !old.closed) { try { old.close(); } catch (_) {} }
    peer.pgmPeerConsumers.delete(slot);
    return null;
  }
  if (!router.canConsume({ producerId: producer.id, rtpCapabilities: peer.rtpCapabilities })) {
    throw new Error('Cannot consume PGM peer audio: capability mismatch');
  }

  const oldConsumer = peer.pgmPeerConsumers.get(slot);
  if (oldConsumer && !oldConsumer.closed) {
    try { oldConsumer.close(); } catch (_) {}
  }

  const consumer = await peer.recvTransport.consume({
    producerId: producer.id,
    rtpCapabilities: peer.rtpCapabilities,
    paused: true,
  });
  peer.consumers.set(consumer.id, consumer);
  peer.pgmPeerConsumers.set(slot, consumer);
  const forget = () => {
    peer.consumers.delete(consumer.id);
    if (peer.pgmPeerConsumers.get(slot) === consumer) peer.pgmPeerConsumers.delete(slot);
  };
  consumer.on('transportclose', forget);
  consumer.on('producerclose', forget);

  console.log(`[mediasoup] PGM cross-monitor: peer=${peerId} stream=${streamId} slot=${slot} producer=${producer.id}`);
  return { id: consumer.id, producerId: producer.id, kind: 'audio', rtpParameters: consumer.rtpParameters, slot };
}

/**
 * Admin -> viewer private talk: lets an admin/superadmin speak directly to
 * ONE specific PGM commentator (identified by their slot on `streamId`), OR
 * to EVERY currently active commentator on that stream at once (pass
 * slot='all', for the panel's "Hablar a los 3" button) -- bypassing the
 * publisher entirely either way. Direction is the REVERSE of normal PGM/
 * Talkback (which always flow viewer -> publisher): here the ADMIN produces
 * ONE producer on their own sendTransport, and EACH target viewer consumes
 * that SAME producer on their own recvTransport (mediasoup lets one Producer
 * feed multiple simultaneous Consumers) -- same pattern as the PGM
 * cross-monitor consumePgmPeerAudio, just fanned out to several targets.
 * "Last one wins" per admin, same as Talkback: one admin can only be
 * actively talking to a single target (one slot, or all of them) at a time
 * (expected to be used push-to-talk style, one short-lived producer per
 * press).
 */
async function produceAdminTalk(adminPeerId, streamId, slot, rtpParameters) {
  const adminPeer = peers.get(adminPeerId);
  if (!adminPeer?.sendTransport) throw new Error(`No send transport for peer=${adminPeerId}`);
  const stream = streams.get(streamId);
  if (!stream) throw new Error(`Stream not found: ${streamId}`);

  let targetPeerIds;
  if (slot === 'all') {
    targetPeerIds = getActivePgmSlots(streamId).map(({ peerId }) => peerId);
    if (targetPeerIds.length === 0) throw new Error('No hay comentaristas activos en PGM');
  } else {
    if (!Number.isInteger(slot) || slot < 0 || slot >= PGM_MAX_SLOTS) throw new Error(`Invalid PGM slot: ${slot}`);
    const targetPeerId = stream.returnProducers?.pgm?.[slot]?.peerId;
    if (!targetPeerId) throw new Error(`No active speaker in slot ${slot}`);
    targetPeerIds = [targetPeerId];
  }
  for (const targetPeerId of targetPeerIds) {
    const targetPeer = peers.get(targetPeerId);
    if (!targetPeer?.recvTransport || !targetPeer.rtpCapabilities) throw new Error('Target viewer not ready');
  }

  const previous = adminPeer.adminTalkProducer;
  if (previous && !previous.producer.closed) { try { previous.producer.close(); } catch (_) {} }

  const producer = await adminPeer.sendTransport.produce({ kind: 'audio', rtpParameters });
  adminPeer.adminTalkProducer = { producer, targetPeerIds, streamId, slot };

  // See the equivalent comment on the PGM/Talkback 'close' handlers above:
  // producer.observer.on('close', ...) is the only hook that reliably fires
  // on every close path (explicit close, transport close, peer cleanup).
  producer.observer.on('close', () => {
    if (adminPeer.adminTalkProducer?.producer === producer) delete adminPeer.adminTalkProducer;
    for (const targetPeerId of targetPeerIds) {
      events.emit('adminTalkChanged', { targetPeerId, active: false });
    }
  });

  for (const targetPeerId of targetPeerIds) {
    events.emit('adminTalkChanged', { targetPeerId, active: true, producerId: producer.id });
  }
  console.log(`[mediasoup] Admin talk: admin=${adminPeerId} -> peers=[${targetPeerIds.join(', ')}] ` +
    `stream=${streamId} ${slot === 'all' ? '(all)' : `slot=${slot}`}`);
  return { producerId: producer.id };
}

/**
 * Called by the TARGET viewer (after receiving the 'adminTalkChanged' push
 * with active=true) to consume whichever admin is currently talking to them,
 * on their own recvTransport. Returns null if no admin is currently talking
 * to this peer (already stopped, or the push raced a stale/closed producer).
 */
async function consumeAdminTalk(peerId) {
  const peer = peers.get(peerId);
  if (!peer?.recvTransport || !peer.rtpCapabilities) throw new Error(`Peer not ready: ${peerId}`);

  let producer = null;
  for (const p of peers.values()) {
    if (p.adminTalkProducer?.targetPeerIds?.includes(peerId) && !p.adminTalkProducer.producer.closed) {
      producer = p.adminTalkProducer.producer;
      break;
    }
  }
  if (!producer) {
    if (peer.adminTalkConsumer && !peer.adminTalkConsumer.closed) { try { peer.adminTalkConsumer.close(); } catch (_) {} }
    delete peer.adminTalkConsumer;
    return null;
  }
  if (!router.canConsume({ producerId: producer.id, rtpCapabilities: peer.rtpCapabilities })) {
    throw new Error('Cannot consume admin talk: capability mismatch');
  }

  if (peer.adminTalkConsumer && !peer.adminTalkConsumer.closed) { try { peer.adminTalkConsumer.close(); } catch (_) {} }

  const consumer = await peer.recvTransport.consume({
    producerId: producer.id,
    rtpCapabilities: peer.rtpCapabilities,
    paused: true,
  });
  peer.consumers.set(consumer.id, consumer);
  peer.adminTalkConsumer = consumer;
  const forget = () => {
    peer.consumers.delete(consumer.id);
    if (peer.adminTalkConsumer === consumer) delete peer.adminTalkConsumer;
  };
  consumer.on('transportclose', forget);
  consumer.on('producerclose', forget);

  return { id: consumer.id, producerId: producer.id, kind: 'audio', rtpParameters: consumer.rtpParameters };
}

/**
 * Guest -> guest private push-to-talk: lets any connected commentator (guest
 * link) speak directly to ONE other currently-active PGM commentator on the
 * SAME stream (identified by their slot), bypassing the admin/publisher
 * entirely. Same producer/consumer pattern as produceAdminTalk/consumeAdminTalk
 * above, just always a single target -- "last one wins" per caller, same as
 * admin talk (expected to be used push-to-talk style, one short-lived
 * producer per press).
 */
async function producePeerTalk(fromPeerId, streamId, targetSlot, rtpParameters) {
  const fromPeer = peers.get(fromPeerId);
  if (!fromPeer?.sendTransport) throw new Error(`No send transport for peer=${fromPeerId}`);
  const stream = streams.get(streamId);
  if (!stream) throw new Error(`Stream not found: ${streamId}`);
  if (!Number.isInteger(targetSlot) || targetSlot < 0 || targetSlot >= PGM_MAX_SLOTS) {
    throw new Error(`Invalid PGM slot: ${targetSlot}`);
  }

  const targetPeerId = stream.returnProducers?.pgm?.[targetSlot]?.peerId;
  if (!targetPeerId) throw new Error(`No active speaker in slot ${targetSlot}`);
  if (targetPeerId === fromPeerId) throw new Error('Cannot talk to yourself');
  const targetPeer = peers.get(targetPeerId);
  if (!targetPeer?.recvTransport || !targetPeer.rtpCapabilities) throw new Error('Target viewer not ready');

  const previous = fromPeer.peerTalkProducer;
  if (previous && !previous.producer.closed) { try { previous.producer.close(); } catch (_) {} }

  const producer = await fromPeer.sendTransport.produce({ kind: 'audio', rtpParameters });
  fromPeer.peerTalkProducer = { producer, targetPeerId, streamId, targetSlot };

  // See the equivalent comment on produceAdminTalk's 'close' handler: this is
  // the only hook that reliably fires on every close path.
  producer.observer.on('close', () => {
    if (fromPeer.peerTalkProducer?.producer === producer) delete fromPeer.peerTalkProducer;
    events.emit('peerTalkChanged', { targetPeerId, active: false });
  });

  events.emit('peerTalkChanged', { targetPeerId, active: true, producerId: producer.id });
  console.log(`[mediasoup] Peer talk: from=${fromPeerId} -> peer=${targetPeerId} ` +
    `stream=${streamId} slot=${targetSlot}`);
  return { producerId: producer.id };
}

/**
 * Called by the TARGET viewer (after receiving the 'peerTalkChanged' push
 * with active=true) to consume whichever fellow commentator is currently
 * talking to them, on their own recvTransport. Returns null if nobody is
 * currently talking to this peer (already stopped, or the push raced a
 * stale/closed producer).
 */
async function consumePeerTalk(peerId) {
  const peer = peers.get(peerId);
  if (!peer?.recvTransport || !peer.rtpCapabilities) throw new Error(`Peer not ready: ${peerId}`);

  let producer = null;
  for (const p of peers.values()) {
    if (p.peerTalkProducer?.targetPeerId === peerId && !p.peerTalkProducer.producer.closed) {
      producer = p.peerTalkProducer.producer;
      break;
    }
  }
  if (!producer) {
    if (peer.peerTalkConsumer && !peer.peerTalkConsumer.closed) { try { peer.peerTalkConsumer.close(); } catch (_) {} }
    delete peer.peerTalkConsumer;
    return null;
  }
  if (!router.canConsume({ producerId: producer.id, rtpCapabilities: peer.rtpCapabilities })) {
    throw new Error('Cannot consume peer talk: capability mismatch');
  }

  if (peer.peerTalkConsumer && !peer.peerTalkConsumer.closed) { try { peer.peerTalkConsumer.close(); } catch (_) {} }

  const consumer = await peer.recvTransport.consume({
    producerId: producer.id,
    rtpCapabilities: peer.rtpCapabilities,
    paused: true,
  });
  peer.consumers.set(consumer.id, consumer);
  peer.peerTalkConsumer = consumer;
  const forget = () => {
    peer.consumers.delete(consumer.id);
    if (peer.peerTalkConsumer === consumer) delete peer.peerTalkConsumer;
  };
  consumer.on('transportclose', forget);
  consumer.on('producerclose', forget);

  return { id: consumer.id, producerId: producer.id, kind: 'audio', rtpParameters: consumer.rtpParameters };
}

/**
 * Viewer -> admin Talkback (reverse of the admin -> viewer private talk above):
 * lets any connected admin/superadmin hear whichever viewer is CURRENTLY
 * holding Talkback on `streamId`, over the admin's own recvTransport (the same
 * one already used for the main video/audio subscription). This is additive:
 * it does NOT replace or interfere with the publisher's own consumeReturnAudio
 * ('talkback' kind) -- a mediasoup Producer can feed both simultaneously.
 * Returns null if nobody is currently on Talkback for this stream (not
 * started yet, or just released/closed) -- any stale consumer this admin
 * still had for it is torn down in that case too.
 */
async function consumeTalkbackAudio(peerId, streamId) {
  const peer = peers.get(peerId);
  if (!peer?.recvTransport || !peer.rtpCapabilities) throw new Error(`Peer not ready: ${peerId}`);
  const stream = streams.get(streamId);
  if (!stream) throw new Error(`Stream not found: ${streamId}`);

  const producer = stream.returnProducers?.talkback;
  if (!producer || producer.closed) {
    const old = peer.talkbackConsumers.get(streamId);
    if (old && !old.closed) { try { old.close(); } catch (_) {} }
    peer.talkbackConsumers.delete(streamId);
    return null;
  }
  if (!router.canConsume({ producerId: producer.id, rtpCapabilities: peer.rtpCapabilities })) {
    throw new Error('Cannot consume talkback audio: capability mismatch');
  }

  const oldConsumer = peer.talkbackConsumers.get(streamId);
  if (oldConsumer && !oldConsumer.closed) {
    try { oldConsumer.close(); } catch (_) {}
  }

  const consumer = await peer.recvTransport.consume({
    producerId: producer.id,
    rtpCapabilities: peer.rtpCapabilities,
    paused: true,
  });
  peer.consumers.set(consumer.id, consumer);
  peer.talkbackConsumers.set(streamId, consumer);
  const forget = () => {
    peer.consumers.delete(consumer.id);
    if (peer.talkbackConsumers.get(streamId) === consumer) peer.talkbackConsumers.delete(streamId);
  };
  consumer.on('transportclose', forget);
  consumer.on('producerclose', forget);

  console.log(`[mediasoup] Talkback consumed by admin: peer=${peerId} stream=${streamId} producer=${producer.id}`);
  return { id: consumer.id, producerId: producer.id, kind: 'audio', rtpParameters: consumer.rtpParameters };
}

/**
 * Explicitly pause/resume the SERVER-side return-audio Producer for a peer's
 * kind (called when the viewer toggles Mic/Talkback off/on). This is a
 * defense-in-depth complement to mediasoup-client's local track.enabled
 * toggling: mediasoup-client's Producer.pause()/resume() does NOT notify the
 * server by default (only zeroRtpOnPause:true would), so without this the
 * server-side Producer stays "active" forever and only the browser's local
 * silence generation prevents real audio from reaching the publisher. Pausing
 * the actual server Producer makes mediasoup stop forwarding RTP to its
 * Consumers immediately and unconditionally, regardless of browser behavior.
 */
async function setReturnProducerPaused(peerId, kind, paused) {
  if (!RETURN_KINDS.includes(kind)) throw new Error(`Invalid return kind: ${kind}`);
  const peer = peers.get(peerId);
  const entry = peer?.returnProducers?.[kind];
  const producer = entry?.producer;
  if (!producer || producer.closed) return;
  if (paused) await producer.pause(); else await producer.resume();
  // Talkback push-to-talk: flip the admin panel's green light in near-real
  // time. Deliberately a SEPARATE, lightweight event from
  // 'returnProducerChanged' -- that one tells the publisher to re-consume
  // the producer (see tools/publish.js), which would pointlessly tear down
  // and relink its GStreamer pad on every single press/release. This event
  // only triggers a plain streams re-broadcast (see signaling.js).
  if (kind === 'talkback' && entry.streamId) {
    const stream = streams.get(entry.streamId);
    if (stream && stream.returnProducers.talkback === producer) {
      stream.talkbackActive = !paused;
      events.emit('talkbackStateChanged', { streamId: entry.streamId, active: stream.talkbackActive });
    }
  }
}

async function connectTransport(peerId, transportId, dtlsParameters) {
  const peer = peers.get(peerId);
  let transport =
    peer?.recvTransport?.id === transportId ? peer.recvTransport :
    peer?.sendTransport?.id === transportId ? peer.sendTransport : null;
  if (!transport && peer?.returnRecvTransports) {
    transport = Object.values(peer.returnRecvTransports).find(t => t?.id === transportId) || null;
  }
  if (!transport) {
    throw new Error(`Transport not found: peer=${peerId} transport=${transportId}`);
  }
  await transport.connect({ dtlsParameters });
}

function setPeerRtpCapabilities(peerId, rtpCapabilities) {
  const peer = _ensurePeer(peerId);
  peer.rtpCapabilities = rtpCapabilities;
}

// ======================== CONSUME (viewer subscribes to stream) ========================

async function subscribe(peerId, streamId) {
  const peer = peers.get(peerId);
  if (!peer?.recvTransport || !peer.rtpCapabilities) {
    throw new Error(`Peer not ready: ${peerId}`);
  }
  const stream = streams.get(streamId);
  if (!stream) throw new Error(`Stream not found: ${streamId}`);

  const results = [];

  // Video consumer
  if (stream.producer && router.canConsume({ producerId: stream.producer.id, rtpCapabilities: peer.rtpCapabilities })) {
    const consumer = await peer.recvTransport.consume({
      producerId: stream.producer.id,
      rtpCapabilities: peer.rtpCapabilities,
      paused: true,
    });
    peer.consumers.set(consumer.id, consumer);
    consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
    consumer.on('producerclose', () => peer.consumers.delete(consumer.id));
    results.push({
      id: consumer.id, producerId: stream.producer.id,
      kind: 'video', rtpParameters: consumer.rtpParameters, streamId,
    });
  }

  // Audio consumer
  if (stream.audioProducer && router.canConsume({ producerId: stream.audioProducer.id, rtpCapabilities: peer.rtpCapabilities })) {
    const consumer = await peer.recvTransport.consume({
      producerId: stream.audioProducer.id,
      rtpCapabilities: peer.rtpCapabilities,
      paused: true,
    });
    peer.consumers.set(consumer.id, consumer);
    consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
    consumer.on('producerclose', () => peer.consumers.delete(consumer.id));
    results.push({
      id: consumer.id, producerId: stream.audioProducer.id,
      kind: 'audio', rtpParameters: consumer.rtpParameters, streamId,
    });
  }

  if (results.length === 0) throw new Error(`Cannot consume: codec mismatch for stream=${streamId}`);

  console.log(`[mediasoup] Subscribe: peer=${peerId} stream=${streamId} consumers=${results.map(r => r.kind).join('+')}`);  
  return results.length === 1 ? results[0] : { consumers: results, streamId };
}

async function resumeConsumer(peerId, consumerId) {
  const peer = peers.get(peerId);
  const consumer = peer?.consumers.get(consumerId);
  if (consumer) await consumer.resume();
}

// ======================== CLEANUP ========================

function cleanupPeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  for (const c of peer.consumers.values()) {
    try { c.close(); } catch (_) {}
  }
  // pgmPeerConsumers entries are already included in peer.consumers above (see
  // consumePgmPeerAudio), so this is just clearing the by-slot index -- the
  // actual mediasoup Consumers were already closed by the loop above.
  peer.pgmPeerConsumers?.clear();
  peer.talkbackConsumers?.clear();
  for (const entry of Object.values(peer.returnProducers || {})) {
    try { entry.producer.close(); } catch (_) {}
  }
  try { peer.adminTalkProducer?.producer.close(); } catch (_) {}
  try { peer.peerTalkProducer?.producer.close(); } catch (_) {}
  try { peer.recvTransport?.close(); } catch (_) {}
  try { peer.sendTransport?.close(); } catch (_) {}
  for (const transport of Object.values(peer.returnRecvTransports || {})) {
    try { transport?.close(); } catch (_) {}
  }
  peers.delete(peerId);
  console.log(`[mediasoup] Peer cleaned up: ${peerId}`);
}

function getViewerCount() {
  return peers.size;
}

function getStats() {
  return {
    streams: getActiveStreams(),
    viewers: peers.size,
    workers: workers.map(w => ({ pid: w.pid })),
  };
}

function resetAll() {
  // Close all streams
  for (const [id, s] of streams) {
    try { s.producer?.close(); } catch (_) {}
    try { s.plainTransport?.close(); } catch (_) {}
    try { s.audioProducer?.close(); } catch (_) {}
    try { s.audioTransport?.close(); } catch (_) {}
    try { s.returnProducers?.talkback?.close(); } catch (_) {}
    for (const entry of s.returnProducers?.pgm || []) {
      if (entry) { try { entry.producer.close(); } catch (_) {} }
    }
  }
  streams.clear();
  ristRelay.stopAll();
  hlsManager.stopAll();
  hlsWanted.clear();
  // Close all viewer transports
  for (const [id, p] of peers) {
    for (const c of p.consumers.values()) try { c.close(); } catch (_) {}
    for (const entry of Object.values(p.returnProducers || {})) try { entry.producer.close(); } catch (_) {}
    try { p.recvTransport?.close(); } catch (_) {}
    try { p.sendTransport?.close(); } catch (_) {}
    for (const transport of Object.values(p.returnRecvTransports || {})) try { transport?.close(); } catch (_) {}
  }
  peers.clear();
  console.log('[mediasoup] All streams and peers reset');
}

module.exports = {
  events,
  init,
  getRouter,
  getRouterRtpCapabilities,
  createPlainTransport,
  publishStream,
  unpublishStream,
  getActiveStreams,
  createWebRtcTransport,
  createSendTransport,
  createReturnRecvTransport,
  produceReturnAudio,
  consumeReturnAudio,
  consumePgmPeerAudio,
  produceAdminTalk,
  consumeAdminTalk,
  producePeerTalk,
  consumePeerTalk,
  consumeTalkbackAudio,
  setOnAir,
  setHlsEnabled,
  getActivePgmSlots,
  setReturnProducerPaused,
  setPgmSlotVolume,
  connectTransport,
  setPeerRtpCapabilities,
  subscribe,
  resumeConsumer,
  cleanupPeer,
  getViewerCount,
  getStats,
  resetAll,
};
