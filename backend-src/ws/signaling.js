const jwt = require('jsonwebtoken');
const ms = require('../services/mediasoup-manager');

const clients = new Map(); // peerId -> { ws, role, user }
let peerSeq = 0;

// Channel lock: streamId -> { peerId, user }
const channelOwners = new Map();

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

  wss.on('connection', (ws) => {
    let peerId = null;
    let peerRole = null;
    let peerUser = null;
    ws.on('pong', () => { ws._dead = false; });

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      try {
        await handleMessage(ws, msg, jwtSecret,
          () => ({ peerId, peerRole, peerUser }),
          (id, role, user) => { peerId = id; peerRole = role; peerUser = user; });
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
          broadcastStreams();
          broadcastChannelStatus();
          console.log(`[Signaling] Publisher disconnected: ${peerId} stream=${ws._streamId}`);
        } else {
          console.log(`[Signaling] Viewer disconnected: ${peerId}`);
        }
        ms.cleanupPeer(peerId);
        clients.delete(peerId);
        broadcastViewerCount();
      }
    });
  });
}

async function handleMessage(ws, msg, jwtSecret, getPeer, setPeer) {
  const { peerId, peerRole, peerUser } = getPeer();

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
      setPeer(id, role, user);
      clients.set(id, { ws, role, user });
      send(ws, { type: 'auth_ok', peerId: id, role });
      send(ws, { type: 'streams', streams: ms.getActiveStreams() });
      send(ws, { type: 'channelStatus', channels: getChannelStatus() });
      broadcastViewerCount();
      console.log(`[Signaling] ${prefix} connected: ${id} (${user}, role=${role})`);
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
      const sid = msg.streamId || ws._streamId;
      if (sid) { ms.unpublishStream(sid); channelOwners.delete(sid); broadcastChannelStatus(); }
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
      const params = await ms.createWebRtcTransport(peerId);
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
      send(ws, { type: 'transportCreated', requestId: msg.requestId, ...params, iceServers });
      break;
    }

    case 'connectTransport':
      await ms.connectTransport(peerId, msg.transportId, msg.dtlsParameters);
      send(ws, { type: 'ok', requestId: msg.requestId });
      break;

    case 'subscribe': {
      const cp = await ms.subscribe(peerId, msg.streamId);
      send(ws, { type: 'subscribed', requestId: msg.requestId, ...cp });
      break;
    }

    case 'resumeConsumer':
      await ms.resumeConsumer(peerId, msg.consumerId);
      send(ws, { type: 'ok', requestId: msg.requestId });
      break;

    case 'enableRist': {
      // Publisher requests RIST relay for a transport
      const ristRelay = require('../services/rist-relay');
      const rp = ristRelay.startRelay(`${ws._streamId}-${msg.rtpPort}`, msg.rtpPort);
      send(ws, { type: 'ristEnabled', requestId: msg.requestId, ristPort: rp });
      break;
    }

    case 'getStreams':
      send(ws, { type: 'streams', streams: ms.getActiveStreams() }); break;

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

function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }

function broadcastViewerCount() {
  const count = [...clients.values()].filter(c => !c.ws._streamId).length;
  const msg = JSON.stringify({ type: 'viewerCount', count });
  for (const c of clients.values()) if (c.ws.readyState === 1) c.ws.send(msg);
}

function broadcastStreams() {
  const msg = JSON.stringify({ type: 'streams', streams: ms.getActiveStreams() });
  for (const c of clients.values()) if (c.ws.readyState === 1) c.ws.send(msg);
}

function broadcastChannelStatus() {
  const msg = JSON.stringify({ type: 'channelStatus', channels: getChannelStatus() });
  for (const c of clients.values()) if (c.ws.readyState === 1) c.ws.send(msg);
}

module.exports = { setupSignaling };
