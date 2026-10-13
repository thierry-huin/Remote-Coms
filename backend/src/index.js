require('dotenv').config({ path: '/app/.env' });

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const config = require('./config');
const ms = require('./services/mediasoup-manager');
const db = require('./services/database');
const {
  setupSignaling, getStreamGuestLink, regenerateStreamGuestLink,
  getStreamHlsLink, regenerateStreamHlsLink,
  resetSignaling, canManageStream,
} = require('./ws/signaling');

const JWT_SECRET = process.env.JWT_SECRET || 'winus-video-secret';

// Defense-in-depth: this process serves EVERY active stream/viewer at once, so
// letting one bad, unrelated promise rejection (e.g. a redundant mediasoup
// API call racing a Producer/Consumer that already closed) crash the whole
// process -- as happened with the PGM AudioLevelObserver.removeProducer()
// race, which killed every stream for every viewer over a single departing
// PGM speaker -- is far worse than logging it and staying up. Genuine
// startup failures are still handled by main().catch() below.
process.on('unhandledRejection', (err) => {
  console.error('[FATAL-AVOIDED] Unhandled rejection (ignored to keep the server up):', err);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL-AVOIDED] Uncaught exception (ignored to keep the server up):', err);
});

// ── JWT Middleware ──
function authMiddleware(requiredRoles) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token required' });
    try {
      const decoded = jwt.verify(header.slice(7), JWT_SECRET);
      req.user = decoded;
      if (requiredRoles && !requiredRoles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

async function main() {
  await ms.init();

  const app = express();
  app.use(express.json());

  // ── Public routes ──
  app.get('/health', (req, res) => res.json({ ok: true, viewers: ms.getViewerCount() }));

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.authenticate(username, password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { user: user.username, role: user.role, userId: user.id },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token, role: user.role });
  });

  // ── Protected routes ──
  // These were labeled "protected" but had NO middleware at all -- anyone,
  // authenticated or not, could hit them. authMiddleware() with no roles
  // array just requires a valid token (any role), which is all these ever
  // needed since no viewer-facing code actually calls them (streams/PGM
  // state comes over the WS 'streams' push instead).
  const anyAuth = authMiddleware();
  app.get('/api/stats', anyAuth, (req, res) => res.json(ms.getStats()));
  app.get('/api/streams', anyAuth, (req, res) => res.json(ms.getActiveStreams()));
  app.get('/api/router-rtp-capabilities', anyAuth, (req, res) => res.json(ms.getRouterRtpCapabilities()));

  // ── User CRUD (admin/superadmin only) ──
  const adminAuth = authMiddleware(['admin', 'superadmin']);
  // Guest-link generation/regeneration: admin/superadmin AND publisher --
  // a publisher needs to be able to hand a commentator their link for a
  // stream they operate, without needing full admin access (which stays
  // gated behind adminAuth everywhere else: user CRUD, Reset Server,
  // disconnect-guest, PGM volume/private-talk, force-stop-stream).
  const linkAuth = authMiddleware(['admin', 'superadmin', 'publisher']);

  // Passwordless guest link for a single stream (e.g. to send to a
  // commentator). The key is generated once, the first time that stream
  // ever publishes video, and never rotates afterwards (see streamGuestKeys
  // in ws/signaling.js) -- so the SAME url keeps working across reconnects
  // and future re-broadcasts of that stream, regardless of who's operating
  // the publisher. It only 404s if that stream has never published at all
  // yet (no key exists to hand out).
  // Prefer EXTERNAL_IP/HTTPS_PORT from .env (the same values deploy.sh
  // prints for "Web viewer:" / used to generate the TLS cert) over the Host
  // header forwarded by nginx: a misconfigured proxy_set_header there (e.g.
  // nginx's $host, which silently drops the port) would otherwise produce a
  // broken link with no obvious error anywhere. Always https: the
  // public-facing side (nginx) only ever serves https.
  function buildGuestLinkUrl(req, streamId, key) {
    const externalIp = process.env.EXTERNAL_IP;
    const httpsPort = process.env.HTTPS_PORT || '9443';
    const host = externalIp
      ? (httpsPort === '443' ? externalIp : `${externalIp}:${httpsPort}`)
      : req.get('host');
    return `https://${host}/?s=${encodeURIComponent(streamId)}&k=${encodeURIComponent(key)}`;
  }

  // A 'publisher' account ("streamer") may only generate/regenerate the
  // link for a stream it is CURRENTLY the live owner of (see
  // canManageStream in ws/signaling.js, backed by channelOwners) -- it can
  // see every stream via GET /api/streams (anyAuth above, unrestricted), but
  // must never be able to hand out or rotate someone ELSE's guest link.
  // admin/superadmin are exempt and can manage any stream.
  function requireStreamOwnership(req, res, next) {
    if (req.user.role !== 'publisher' || canManageStream(req.params.streamId, req.user.role, req.user.user)) {
      return next();
    }
    res.status(403).json({ error: 'Solo pod\u00e9s generar el link de tus propios streams' });
  }

  app.get('/api/streams/:streamId/link', linkAuth, requireStreamOwnership, (req, res) => {
    const key = getStreamGuestLink(req.params.streamId);
    if (!key) return res.status(404).json({ error: 'Stream has never published yet' });
    res.json({ url: buildGuestLinkUrl(req, req.params.streamId, key) });
  });

  // Admin "New Link": rotates the guest key so the OLD link stops working for
  // any future connection attempt (see regenerateStreamGuestLink's docs).
  // Does not affect already-connected guests -- pair with the WS
  // 'disconnectGuest' action to also kick them right now if needed.
  app.post('/api/streams/:streamId/link/regenerate', linkAuth, requireStreamOwnership, (req, res) => {
    const key = regenerateStreamGuestLink(req.params.streamId);
    res.json({ url: buildGuestLinkUrl(req, req.params.streamId, key) });
  });

  // HLS link: same unguessable-key model as the guest link above, but a
  // DELIBERATELY BROADER audience is allowed to generate/copy it --
  // admin/superadmin/publisher (with the same per-stream ownership
  // restriction for 'publisher') PLUS plain 'viewer' accounts, which
  // otherwise have no admin-ish capability anywhere else in this app. This
  // is the one thing a 'viewer' account may do beyond just watching. It does
  // NOT let a viewer turn HLS on/off -- that stays a publisher-only action
  // (see the WS 'setHlsEnabled' case), the link just won't resolve (404 at
  // nginx) until the publisher's own "HLS" checkbox is on. Points DIRECTLY
  // at the raw nginx-served .m3u8 (no web/hls.html wrapper/overlay) -- a TV
  // that can't do WebRTC gets exactly the HLS stream, no clock/name overlay.
  const hlsLinkAuth = authMiddleware(['admin', 'superadmin', 'publisher', 'viewer']);
  function buildHlsLinkUrl(req, streamId, key) {
    const externalIp = process.env.EXTERNAL_IP;
    const httpsPort = process.env.HTTPS_PORT || '9443';
    const host = externalIp
      ? (httpsPort === '443' ? externalIp : `${externalIp}:${httpsPort}`)
      : req.get('host');
    return `https://${host}/hls/${encodeURIComponent(key)}/playlist.m3u8`;
  }

  app.get('/api/streams/:streamId/hls-link', hlsLinkAuth, requireStreamOwnership, (req, res) => {
    const key = getStreamHlsLink(req.params.streamId);
    if (!key) return res.status(404).json({ error: 'Stream has never published yet' });
    res.json({ url: buildHlsLinkUrl(req, req.params.streamId, key) });
  });

  app.post('/api/streams/:streamId/hls-link/regenerate', hlsLinkAuth, requireStreamOwnership, (req, res) => {
    const key = regenerateStreamHlsLink(req.params.streamId);
    res.json({ url: buildHlsLinkUrl(req, req.params.streamId, key) });
  });

  // Deliberately PUBLIC (no JWT): the only endpoint web/hls.html itself
  // needs, since a TV's browser can't practically hold a login session --
  // its security is the same unguessable-key model as everything else here.
  // Validates the key, confirms the stream is currently live AND has HLS
  // actually enabled right now (the link can exist long before/after that),
  // and hands back just enough for the player page to work: the human
  // stream name (for the overlay) and the nginx-served playlist URL.
  app.get('/api/hls-info', (req, res) => {
    const { s: streamId, k: key } = req.query;
    if (!streamId || !key) return res.status(400).json({ error: 'streamId and key required' });
    const expected = getStreamHlsLink(streamId);
    if (!expected || expected !== key) return res.status(404).json({ error: 'Invalid link' });
    const stream = ms.getActiveStreams().find((s) => s.streamId === streamId);
    if (!stream || !stream.hlsEnabled) return res.status(404).json({ error: 'HLS not currently live for this stream' });
    res.json({
      streamName: stream.streamName || streamId,
      playlistUrl: `/hls/${encodeURIComponent(key)}/playlist.m3u8`,
    });
  });

  app.get('/api/users', adminAuth, (req, res) => {
    res.json(db.getUsers());
  });

  app.post('/api/users', adminAuth, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (!['viewer', 'publisher', 'admin'].includes(role || 'viewer')) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    try {
      const user = db.createUser(username, password, role || 'viewer');
      res.status(201).json(user);
    } catch (err) {
      res.status(409).json({ error: 'Username already exists' });
    }
  });

  app.put('/api/users/:id', adminAuth, (req, res) => {
    const user = db.updateUser(parseInt(req.params.id), req.body);
    if (!user) return res.status(404).json({ error: 'User not found or protected' });
    res.json(user);
  });

  app.delete('/api/users/:id', adminAuth, (req, res) => {
    const ok = db.deleteUser(parseInt(req.params.id));
    if (!ok) return res.status(404).json({ error: 'User not found or protected' });
    res.json({ ok: true });
  });

  // Reset endpoint (admin/superadmin only)
  app.post('/api/reset', adminAuth, (req, res) => {
    ms.resetAll();
    // BUGFIX: ms.resetAll() only knows about mediasoup-level resources -- it
    // never cleared signaling.js's own channelOwners "who owns which
    // stream" locks, which left every previously-live stream permanently
    // locked to its now-gone peerId ("Channel X locked by Y" forever, no way
    // to republish without restarting the whole backend process). See
    // resetSignaling's docs in ws/signaling.js.
    resetSignaling();
    res.json({ ok: true, message: 'All streams and connections reset' });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupSignaling(wss, JWT_SECRET);

  server.listen(config.port, () => {
    console.log(`Winus Video Server running on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
