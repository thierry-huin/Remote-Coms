// Winus Video Viewer — with login + single stream fullscreen
const baseUrl = `${location.protocol}//${location.host}`;
const wsUrl = `wss://${location.host}/ws`;
let ws, device, transport, peerId, authToken, userRole;
// The logged-in username itself (NOT persisted server-side per-connection,
// see the JWT's 'user' claim) -- needed so a 'publisher' account can tell
// WHICH of the streams listed in the admin panel are its own (compared
// against each stream's metadata.user, set server-side from 'produce' in
// ws/signaling.js) vs someone else's, see renderAdminStreamsList.
let currentUsername = null;
let activeConsumer = null;
let activeStreamId = null;

// ── Guest link (?s=<streamId>&k=<key>) ──
// Passwordless, single-stream access for people who shouldn't have to deal
// with accounts (e.g. commentators). See startGuestViewer() below.
let streamLocked = false;
let lockedStreamId = null;
let guestAuth = null; // { streamId, key } while using a guest link
let channelStatus = {};
let streamNames = JSON.parse(localStorage.getItem('winus-stream-names') || '{}');
let requestSeq = 0;
const pending = new Map();

// ── Return audio (Mic/PGM + Talkback) ──
let sendTransport = null;
let pgmProducer = null;
let talkbackProducer = null;
let micOn = false;
let talkbackOn = false;
// PGM "cross-monitor": while this viewer is an active PGM speaker, it also
// consumes (and plays) the audio of every OTHER active PGM speaker on the
// same stream, over the SAME recvTransport already used for the main video/
// audio subscription. pgmOwnSlot is set from produceReturn's response (see
// ensureSendTransport's 'produce' handler) so we never try to consume
// ourselves; pgmPeerAudioEls maps slot -> { consumer, audioEl }.
let pgmOwnSlot = null;
const pgmPeerAudioEls = new Map();
// Per-listener volume for each OTHER active PGM speaker's cross-monitor
// audio (see consumePgmPeerSlot/renderPgmPeerVolumeControls) -- adjusting
// an HTMLMediaElement's .volume is purely local to THIS browser, so this
// only ever changes what THIS commentator hears, never anyone else's mix.
// Deliberately NOT persisted (localStorage): always starts at 100% on a
// fresh page load, but kept in memory for the rest of the session so a
// brief reconnect (slot's audio element torn down/recreated) doesn't
// silently reset a mid-session adjustment.
const pgmPeerVolumes = new Map(); // slot -> 0..1
// Admin -> viewer private talk: the admin's OWN outgoing producer (set while
// they hold down a per-slot "talk" button in the admin panel), and, on the
// RECEIVING viewer's side, the consumer+<audio> currently playing whichever
// admin is talking to them. See startAdminTalk/stopAdminTalk (admin side)
// and consumeAdminTalkAudio/stopAdminTalkAudio (viewer side) below.
let adminTalkProducer = null;
let adminTalkPressed = false;
let adminTalkAudio = null;
// Guest -> guest Latch talk (see togglePeerTalk/startPeerTalk/stopPeerTalk):
// click a peer's "Hablar" button to start, click it again (or a DIFFERENT
// peer's button) to stop/switch -- restores Mic to whatever it was right
// before talking started once it ends -- peerTalkOn is consulted by
// applyPgmState() alongside micOn/talkbackOn for exactly that reason.
let peerTalkProducer = null;
let peerTalkPressed = false;
let peerTalkOn = false;
let peerTalkTargetSlot = null;
// On the RECEIVING end: the consumer+<audio> currently playing whichever
// fellow commentator is Latch-talking to us (see consumePeerTalkAudio).
let peerTalkAudio = null;
// Viewer -> admin Talkback (reverse of the above): while logged in as
// admin/superadmin, plays whichever guest-link viewer is currently holding
// Talkback on a given stream, pushed via 'talkbackAudioChanged'. Keyed by
// streamId since an admin may have several streams' rows visible at once.
const talkbackFromViewerAudioEls = new Map();
// Admin PGM "listen" (monitor-only, never talks back): the ONE stream (if
// any) whose PGM the admin is currently listening to, plus one Consumer/
// <audio> per currently-active slot on it. Only one stream at a time --
// starting a new one stops whichever was previously playing. Reuses the
// same 'consumePgmPeer' request as the PGM cross-monitor feature (see
// consumePgmPeerAudio server-side), since an admin is never itself a PGM
// speaker so there's no "own slot" to skip.
let pgmListenStreamId = null;
const pgmListenAudioEls = new Map(); // slot -> { consumer, audioEl }
// Guards against the admin panel's periodic full re-render (see
// renderAdminStreamsList) yanking out from under an in-progress slider drag
// or held "talk" button press -- replacing those DOM nodes mid-interaction
// breaks the browser's pointer capture, making them feel unresponsive.
// Self-healing: if the mouse/touch is ever released OUTSIDE the page (e.g.
// dragged off the browser window entirely), no mouseup/touchend DOM event
// fires at all -- none of our onmouseup/onmouseleave/touchend handlers, nor
// the document-level safety net below, would ever run, permanently stuck
// with the panel (VU meters, slider positions, and the Talkback light)
// frozen forever. adminPanelHoldTimer guarantees it auto-clears (and
// immediately re-renders with whatever's current) a few seconds after the
// last hold-start, regardless of whether a matching hold-end ever arrives.
let adminPanelSuspendRender = false;
let adminPanelHoldTimer = null;
function adminPanelHoldStart() {
  adminPanelSuspendRender = true;
  clearTimeout(adminPanelHoldTimer);
  adminPanelHoldTimer = setTimeout(adminPanelHoldEnd, 4000);
}
function adminPanelHoldEnd() {
  clearTimeout(adminPanelHoldTimer);
  const wasSuspended = adminPanelSuspendRender;
  adminPanelSuspendRender = false;
  // Don't wait for the next unrelated broadcast to reflect the panel's
  // current (possibly stale-while-suspended) state -- refresh right away.
  if (wasSuspended) renderAdminStreamsList();
}
// Optional display name the viewer can type ("Tu nombre" field near Mic/Talkback)
// so the admin's PGM slot list shows something more useful than the account
// username -- especially for guest links, where peerUser is the same generic
// "guest:<streamId>" string for whoever holds the link. Persisted across
// reloads; only takes effect for the NEXT time Mic is activated (see
// ensureReturnProducer), not retroactively for an already-active producer.
let displayName = localStorage.getItem('winus-display-name') || '';
// analyser per kind, tapped (monitor-only, not inserted into the actual
// send path) from the raw mic stream so the VU meter can show its level.
// Built lazily in ensureReturnProducers().
let pgmAnalyser = null, talkbackAnalyser = null;
let audioCtx = null;
// Volume of the incoming audio from the publisher (what the viewer hears),
// applied directly to the <video> element. See setPlaybackVolume().
let playbackVolume = 1.0;

// ── Incoming-audio VU meter (mono) ──
// Purely a monitor tap on the publisher's audio track (never connected to
// an output), so it's entirely independent of the volume slider/video.volume
// above -- it shows the level of what's actually arriving, not what's audible.
// Mono, not stereo: a ChannelSplitter here didn't actually isolate L/R for a
// remote WebRTC track in testing -- both outputs read the same L+R sum --
// so a fake "stereo" meter (two bars moving in lockstep) is worse than an
// honest single mono meter.
let incomingSourceNode = null;
let incomingAnalyser = null;

// ── Audio jitter buffer ──
// Fixed low-latency target (0ms = minimum) for the incoming audio track
// only. Lower = less delay but more prone to glitches/dropouts under
// network jitter; the browser may still buffer more than this internally
// if it detects real jitter, this is just a target/hint, not a hard cap.
const AUDIO_BUFFER_MS = 0;

// ── LOGIN ──
function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('main-screen').style.display = 'none';
  const saved = localStorage.getItem('winus-video-token');
  if (saved) { authToken = saved; startViewer(); }
}

async function doLogin() {
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value.trim();
  const errEl = document.getElementById('login-error');
  if (!user || !pass) { errEl.textContent = 'Fill in username and password'; return; }
  errEl.textContent = 'Connecting...';
  try {
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    if (!res.ok) { errEl.textContent = 'Invalid credentials'; return; }
    const data = await res.json();
    authToken = data.token;
    userRole = data.role;
    currentUsername = user;
    localStorage.setItem('winus-video-token', authToken);
    localStorage.setItem('winus-video-role', userRole);
    localStorage.setItem('winus-video-username', currentUsername);
    startViewer();
  } catch (e) {
    errEl.textContent = `Error: ${e.message}`;
  }
}

function logout() {
  localStorage.removeItem('winus-video-token');
  authToken = null;
  disconnectStream();
  stopAllTalkbackFromViewer();
  stopPgmListen();
  if (ws) ws.close();
  showLogin();
}

function startViewer() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('main-screen').style.display = 'block';
  // Show the Streams/admin panel button for admin/superadmin (full panel,
  // including User Management) AND for publisher (Streams panel only --
  // just enough to generate/copy a stream's guest link, see toggleAdmin's
  // per-role gating and renderAdminStreamsList below). Every other action
  // in that panel (PGM volume, private talk, disconnect guest, force-stop)
  // stays admin/superadmin-only, enforced again server-side regardless of
  // what the UI shows.
  const role = userRole || localStorage.getItem('winus-video-role');
  userRole = role; // ensure the global is populated on the saved-token reload path too
  currentUsername = currentUsername || localStorage.getItem('winus-video-username') || '';
  const btnAdmin = document.getElementById('btn-admin');
  if (role === 'admin' || role === 'superadmin') {
    btnAdmin.textContent = 'Users';
    btnAdmin.style.display = 'inline-block';
  } else if (role === 'publisher') {
    btnAdmin.textContent = 'Streams';
    btnAdmin.style.display = 'inline-block';
  }
  connect();
}

// Entry point for a "?s=<streamId>&k=<key>" guest link: no login screen, no
// stream picker, no admin/logout affordances -- just that one stream.
function startGuestViewer(streamId, key) {
  streamLocked = true;
  lockedStreamId = streamId;
  guestAuth = { streamId, key };
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('main-screen').style.display = 'block';
  const logoutBtn = document.querySelector('.header button[onclick="logout()"]');
  if (logoutBtn) logoutBtn.style.display = 'none';
  connect();
}

// ── WS ──
function setStatus(text, cls) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = cls;
}

function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    if (guestAuth) {
      ws.send(JSON.stringify({ type: 'authGuest', streamId: guestAuth.streamId, key: guestAuth.key }));
    } else {
      ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    }
  };
  ws.onclose = () => {
    setStatus('Disconnected — reconnecting...', 'status-error');
    setTimeout(connect, 3000);
  };
  ws.onerror = () => {};
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.requestId && pending.has(msg.requestId)) {
      pending.get(msg.requestId).resolve(msg);
      pending.delete(msg.requestId);
      return;
    }
    handleMessage(msg);
  };
}

function request(type, data = {}) {
  const requestId = ++requestSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${type} timeout`)); }, 10000);
    pending.set(requestId, { resolve: (msg) => { clearTimeout(timer); resolve(msg); }, reject });
    ws.send(JSON.stringify({ type, requestId, ...data }));
  });
}

async function handleMessage(msg) {
  switch (msg.type) {
    case 'auth_ok':
      peerId = msg.peerId;
      userRole = msg.role || userRole;
      if (!streamLocked) {
        localStorage.setItem('winus-video-role', userRole);
        if (userRole === 'admin' || userRole === 'superadmin')
          document.getElementById('btn-admin').style.display = 'inline-block';
      }
      setStatus('Connected', 'status-ok');
      await setupDevice();
      if (streamLocked) renderStreamList(lastStreams); // retry auto-select now that transport is ready
      break;
    case 'auth_error':
      if (streamLocked) {
        // A guest link that's invalid or whose stream already ended -- there's
        // no login to fall back to, just say so.
        setStatus('Este enlace ya no está disponible (el stream no está activo).', 'status-error');
        break;
      }
      setStatus(`Auth failed: ${msg.error}`, 'status-error');
      localStorage.removeItem('winus-video-token');
      localStorage.removeItem('winus-video-role');
      showLogin();
      break;
    case 'streams': {
      // Admin PGM "listen": stop if the stream we're monitoring just ended.
      if (pgmListenStreamId && !msg.streams.some(s => s.streamId === pgmListenStreamId)) {
        stopPgmListen();
      }
      if (activeStreamId) {
        const cur = msg.streams.find(s => s.streamId === activeStreamId);
        if (cur && activeConsumer) {
          // Re-subscribe if producer changed OR audio became available
          const hasAudioConsumer = activeConsumers.some(c => c.track?.kind === 'audio');
          if (cur.producerId !== activeConsumer.producerId || (cur.hasAudio && !hasAudioConsumer)) {
            console.log('Stream updated, re-subscribing...');
            disconnectStream();
            renderStreamList(msg.streams);
            selectStream(cur.streamId);
            break;
          }
        }
      }
      renderStreamList(msg.streams);
      updateOnAirBadge(msg.streams);
      renderPeerSidebar(msg.streams);
      break;
    }
    case 'channelStatus':
      channelStatus = msg.channels || {};
      renderStreamList(lastStreams || []);
      break;
    case 'viewerCount':
      document.getElementById('viewers').textContent = `${msg.count} viewer${msg.count !== 1 ? 's' : ''}`;
      break;
    case 'pgmLevels': {
      // Admin-only push (see signaling.js): one VU meter per PGM slot for
      // whichever streams currently have active speakers. No-op (getVuSegments
      // returns []) if the admin panel isn't open / this stream's row hasn't
      // been rendered, so this is safe to receive unconditionally. Uses more
      // segments than the on-video meter (see ADMIN_VU_SEGMENT_COUNT) since
      // these render bigger in the admin panel and benefit from finer detail.
      const levels = msg.levels || [];
      for (let slot = 0; slot < levels.length; slot++) {
        const segments = getVuSegments(`pgm-vu-${msg.streamId}-${slot}`, ADMIN_VU_SEGMENT_COUNT);
        if (segments.length) renderSegmentedMeter(segments, dbLevelToPercent(levels[slot]));
      }
      break;
    }
    case 'pgmPeerChanged': {
      // Cross-monitor: another PGM slot on our stream just took a producer or
      // lost one. Only relevant while WE are ourselves an active PGM speaker
      // (pgmProducer set) -- plain viewers never cross-monitor anyone.
      if (pgmProducer && msg.streamId === activeStreamId && msg.slot !== pgmOwnSlot) {
        consumePgmPeerSlot(msg.slot);
      }
      // Admin PGM "listen": the stream we're currently monitoring just had a
      // slot come or go -- (re)consume it (or drop it, if now empty).
      if (pgmListenStreamId === msg.streamId) {
        consumePgmListenSlot(msg.streamId, msg.slot);
      }
      break;
    }
    case 'adminTalkChanged': {
      // An admin started (or stopped) talking privately to US (see the
      // per-slot "talk" button in the admin panel). Push-to-talk: 'active'
      // flips true/false as the admin holds/releases their button.
      if (msg.active) consumeAdminTalkAudio();
      else stopAdminTalkAudio();
      break;
    }
    case 'peerTalkChanged': {
      // A fellow commentator started (or stopped) Latch-talking to US (see
      // the per-peer "Hablar" boxes in the sidebar, renderPeerSidebar).
      if (msg.active) consumePeerTalkAudio();
      else stopPeerTalkAudio();
      break;
    }
    case 'talkbackAudioChanged': {
      // Reverse direction: a guest-link viewer started (or stopped) holding
      // Talkback on msg.streamId. Only admin/superadmin ever receive this
      // push (see signaling.js), so no role check needed here.
      if (msg.active) {
        // An incoming call takes priority over passively monitoring PGM --
        // cut the PGM listen so it doesn't collide/overlap with the caller's
        // audio in the admin's ears.
        stopPgmListen();
        consumeTalkbackFromViewer(msg.streamId);
      }
      else stopTalkbackFromViewer(msg.streamId);
      break;
    }
  }
}

async function setupDevice() {
  const caps = await request('getRouterRtpCapabilities');
  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: caps.rtpCapabilities });
  await request('setRtpCapabilities', { rtpCapabilities: device.rtpCapabilities });

  const tData = await request('createWebRtcTransport');
  transport = device.createRecvTransport({
    id: tData.id,
    iceParameters: tData.iceParameters,
    iceCandidates: tData.iceCandidates,
    dtlsParameters: tData.dtlsParameters,
    iceServers: tData.iceServers,
  });
  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    request('connectTransport', { transportId: transport.id, dtlsParameters })
      .then(() => callback()).catch(errback);
  });
}

let lastStreams = [];
function renderStreamList(streams) {
  lastStreams = streams;
  // Refresh the peer sidebar boxes (name/volume/VU meter/Hablar button --
  // see renderPeerSidebar) -- a peer's display name can change while we're
  // already monitoring them, cheap no-op if none active.
  renderPeerSidebar(streams);
  const list = document.getElementById('stream-list');
  const noStreams = document.getElementById('no-streams');

  if (streamLocked) {
    // Guest link: never show the picker, just auto-connect to (or drop, if
    // it just ended) the one stream this link is scoped to.
    list.style.display = 'none';
    noStreams.style.display = 'none';
    const target = streams.find(s => s.streamId === lockedStreamId);
    if (target && activeStreamId !== target.streamId) selectStream(target.streamId);
    else if (!target && activeStreamId) disconnectStream();
    return;
  }

  noStreams.style.display = streams.length ? 'none' : 'block';
  list.innerHTML = '';
  for (const s of streams) {
    const btn = document.createElement('button');
    btn.className = 'stream-btn' + (activeStreamId === s.streamId ? ' active' : '');
    btn.dataset.streamId = s.streamId;
    const label = s.streamName || s.streamId.replace('stream-', 'CH ');
    const owner = channelStatus[s.streamId];
    btn.textContent = owner ? `${label} (${owner.user})` : label;
    btn.onclick = () => selectStream(s.streamId);
    list.appendChild(btn);
  }
  if (activeStreamId && !streams.find(s => s.streamId === activeStreamId)) disconnectStream();

  // Keep the admin "Streams" panel (Copiar enlace) in sync too, e.g. when a
  // second/third stream comes online AFTER the admin panel was opened --
  // otherwise it stays frozen showing only whichever streams were live at
  // that exact moment.
  const adminPanel = document.getElementById('admin-panel');
  if (adminPanel && adminPanel.style.display === 'block') renderAdminStreamsList();
}

let activeConsumers = []; // track all active consumers (video + audio)

async function selectStream(streamId) {
  if (activeStreamId === streamId) return;
  // Must come before touching any state below: otherwise a call that
  // arrives before setupDevice() finishes (e.g. the 'streams' message can
  // arrive right after auth_ok, before transport exists yet for a guest
  // link) would mark activeStreamId as already set and never actually
  // subscribe -- nor get retried, since later calls see activeStreamId
  // already matching and skip themselves too.
  if (!transport) return;
  // Close existing consumers
  for (const c of activeConsumers) try { c.close(); } catch (_) {}
  activeConsumers = [];
  activeConsumer = null;
  resetReturnAudio(); // return audio (Mic/Talkback) is tied to the previous stream's publisher
  activeStreamId = streamId;
  // Compare by the button's data-stream-id (set in renderStreamList), NOT
  // btn.textContent -- textContent is the human-readable label (e.g.
  // "Jazz"), never equal to a streamId (e.g. "stream-1"), so this used to
  // silently never match and the just-clicked button lost its highlight
  // immediately instead of staying lit (it only reappeared once the next
  // 'streams' broadcast triggered a full renderStreamList() re-render,
  // which already compared correctly).
  document.querySelectorAll('.stream-btn').forEach(btn => {
    btn.className = 'stream-btn' + (btn.dataset.streamId === streamId ? ' active' : '');
  });
  try {
    const sub = await request('subscribe', { streamId });

    // Handle single or multi-consumer response
    const consumerList = sub.consumers || [sub];
    const tracks = [];

    for (const cd of consumerList) {
      const consumer = await transport.consume({
        id: cd.id, producerId: cd.producerId,
        kind: cd.kind, rtpParameters: cd.rtpParameters,
      });
      activeConsumers.push(consumer);
      if (cd.kind === 'video') activeConsumer = consumer;
      tracks.push(consumer.track);
      await request('resumeConsumer', { consumerId: consumer.id });
    }

    const video = document.getElementById('main-video');
    video.srcObject = new MediaStream(tracks);
    const hasAudio = tracks.some(t => t.kind === 'audio');
    video.muted = true;
    video.volume = playbackVolume;
    video.play().catch(() => {});
    // "Retorno" sidebar box (fader + VU meter for the audio arriving FROM
    // the publisher) -- see #retorno-box/#sidebar-controls in index.html.
    const retornoBox = document.getElementById('retorno-box');
    if (retornoBox) retornoBox.style.display = hasAudio ? 'flex' : 'none';
    setupIncomingVuMeter(hasAudio ? tracks.find(t => t.kind === 'audio') : null);
    // Mute/unmute toggle lives ONLY on the speaker icon now, not the whole
    // video (clicking anywhere on the video used to toggle audio, which was
    // easy to trigger by accident e.g. while trying to look at the image).
    // Fixed-size icon-only button (see #mute-hint CSS) -- the state is shown
    // via the icon + tooltip only, never as button text, so its size never
    // changes and can't shift the sidebar/video layout next to it.
    const muteHint = document.getElementById('mute-hint');
    muteHint.onclick = () => {
      video.muted = !video.muted;
      muteHint.textContent = video.muted ? '🔇' : '🔊';
      muteHint.title = video.muted ? 'Click to unmute' : 'Audio on';
    };
    const label = lastStreams.find(s => s.streamId === streamId);
    document.getElementById('video-name').textContent = label?.streamName || streamId;
    document.getElementById('video-sidebar-layout').style.display = 'flex';
    document.getElementById('sidebar-controls').style.display = 'flex';
    muteHint.textContent = '🔇';
    muteHint.title = hasAudio ? 'Click to unmute' : 'No audio';
    // Guest-link (commentator) sessions never show Disconnect -- closing the
    // tab/page is enough to drop them, and the button only invited confusion
    // (guest links are locked to a single stream anyway, so there's nowhere
    // else to "go back" to after disconnecting). Regular logged-in viewers/
    // admins keep it, since they can pick a different stream afterwards.
    document.getElementById('btn-disconnect').style.display = streamLocked ? 'none' : 'inline-block';
    const hlsBtn = document.getElementById('btn-hls-link');
    if (hlsBtn) hlsBtn.style.display = streamLocked ? 'none' : 'inline-block';
    startLatencyMonitor();
    updateReturnAudioUI();
    updateReturnAudioAvailability(label?.metadata);
    updateOnAirBadge(lastStreams);
    renderPeerSidebar(lastStreams);
    applyAudioBufferTarget();
  } catch (err) {
    console.error(`Subscribe failed: ${streamId}`, err);
    setStatus(`Error: ${err.message}`, 'status-error');
  }
}

// "ON AIR" box (see setOnAir/onAirChanged server-side): shown whenever the
// CURRENTLY selected/subscribed stream has its publisher-controlled onAir
// flag set, for both admin and guest-link viewers alike. Purely visual --
// unrelated to PGM/Talkback availability/state.
function updateOnAirBadge(streams) {
  const badge = document.getElementById('onair-badge');
  if (!badge) return;
  const s = (streams || lastStreams).find(x => x.streamId === activeStreamId);
  badge.style.display = (s && s.onAir) ? 'flex' : 'none';
}

// Sidebar boxes (see #sidebar-controls/#peer-sidebar-boxes in index.html):
// shown ONLY for guest-link sessions (streamLocked), one box per OTHER
// currently-occupied PGM slot on the active stream (excluding our own, via
// pgmOwnSlot), so commentators can see whether they're accompanied or
// alone. Each box has: a volume fader (local-only, see
// pgmPeerVolumes/setPgmPeerVolume), that peer's own VU meter (fed by a
// per-slot analyser, see consumePgmPeerSlot/startVuMeterLoop), and a Latch
// "Hablar" button (togglePeerTalk) labeled with that peer's name -- no
// separate name label above the fader, the button already shows it. Blue
// while active (see updatePeerTalkButtons, which keeps this in sync
// whenever peerTalkOn/peerTalkTargetSlot change without a full re-render).
function renderPeerSidebar(streams) {
  const container = document.getElementById('peer-sidebar-boxes');
  if (!container) return;
  if (!streamLocked) { container.innerHTML = ''; return; }
  const s = (streams || lastStreams).find(x => x.streamId === activeStreamId);
  const slots = s?.pgmSlots || [];
  const others = [];
  slots.forEach((slot, i) => { if (slot && i !== pgmOwnSlot) others.push({ slot: i, user: slot.user || `Comentarista ${i + 1}` }); });
  if (!others.length) { container.innerHTML = ''; return; }
  container.innerHTML = others.map(({ slot, user }) => {
    const value = Math.round((pgmPeerVolumes.has(slot) ? pgmPeerVolumes.get(slot) : 1) * 100);
    const talking = peerTalkOn && peerTalkTargetSlot === slot;
    return `
    <div class="sidebar-box">
      <div class="sidebar-box-fader-row">
        <div class="fader-vertical-wrap">
          <input type="range" min="0" max="100" value="${value}" title="Volumen de ${user} (solo para vos)"
            oninput="setPgmPeerVolume(${slot}, this.value/100)">
        </div>
        <div id="peer-vu-${slot}" class="sidebar-vu-meter" title="Nivel de ${user}"></div>
      </div>
      <button type="button" class="btn-peer-talk ${talking ? 'active' : ''}" data-slot="${slot}" onclick="togglePeerTalk(${slot})"
        title="Hablarle a ${user} (click para activar/desactivar)">📞 ${user}</button>
    </div>`;
  }).join('');
}

// Keeps every peer box's "Hablar" button's active/inactive color in sync
// with peerTalkOn/peerTalkTargetSlot -- called directly from
// startPeerTalk/stopPeerTalk (see togglePeerTalk) instead of going through
// a full renderPeerSidebar() re-render, which would be needlessly heavy
// (rebuilds every fader/VU meter DOM node) just to flip one class.
function updatePeerTalkButtons() {
  document.querySelectorAll('.btn-peer-talk').forEach((btn) => {
    const slot = Number(btn.dataset.slot);
    btn.classList.toggle('active', peerTalkOn && peerTalkTargetSlot === slot);
  });
}

function disconnectStream() {
  for (const c of activeConsumers) try { c.close(); } catch (_) {}
  activeConsumers = [];
  activeConsumer = null;
  activeStreamId = null;
  document.getElementById('main-video').srcObject = null;
  document.getElementById('video-sidebar-layout').style.display = 'none';
  document.getElementById('sidebar-controls').style.display = 'none';
  document.getElementById('video-container').classList.remove('tally-pgm', 'tally-talkback');
  document.getElementById('onair-badge').style.display = 'none';
  renderPeerSidebar([]);
  document.getElementById('return-audio-controls').style.display = 'none';
  document.getElementById('vu-meter').style.display = 'none';
  document.getElementById('retorno-box').style.display = 'none';
  document.getElementById('btn-disconnect').style.display = 'none';
  const hlsBtn = document.getElementById('btn-hls-link');
  if (hlsBtn) hlsBtn.style.display = 'none';
  stopLatencyMonitor();
  resetReturnAudio();
  teardownIncomingVuMeter();
  document.querySelectorAll('.stream-btn').forEach(btn => btn.className = 'stream-btn');
}

// ── Return audio: Mic (PGM) + Talkback ──
// Mic = program audio (commentary), mixed by the publisher into the outgoing feed.
// Talkback = private channel to a technician at the publisher; forces Mic off while active.
async function ensureSendTransport() {
  if (sendTransport) return sendTransport;
  const tData = await request('createSendTransport');
  sendTransport = device.createSendTransport({
    id: tData.id,
    iceParameters: tData.iceParameters,
    iceCandidates: tData.iceCandidates,
    dtlsParameters: tData.dtlsParameters,
    iceServers: tData.iceServers,
  });
  sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    request('connectTransport', { transportId: sendTransport.id, dtlsParameters })
      .then(() => callback()).catch(errback);
  });
  sendTransport.on('produce', ({ rtpParameters, appData }, callback, errback) => {
    // 'adminTalk' targets one specific PGM slot's occupant (see startAdminTalk)
    // instead of the current stream's PGM/Talkback channel, so it needs its own
    // request shape/type rather than 'produceReturn'. 'peerTalk' is the guest-
    // to-guest equivalent (see startPeerTalk), always a single target slot.
    const isAdminTalk = appData.returnKind === 'adminTalk';
    const isPeerTalk = appData.returnKind === 'peerTalk';
    const requestType = isAdminTalk ? 'produceAdminTalk' : isPeerTalk ? 'producePeerTalk' : 'produceReturn';
    const payload = isAdminTalk
      ? { streamId: appData.streamId, slot: appData.slot, rtpParameters }
      : isPeerTalk
      ? { streamId: appData.streamId, targetSlot: appData.targetSlot, rtpParameters }
      : { streamId: activeStreamId, kind: appData.returnKind, rtpParameters, displayName: appData.displayName };
    request(requestType, payload).then((resp) => {
      // Cross-monitor: remember which PGM slot the server assigned us so we
      // never try to consume our own audio back (see consumePgmPeerSlot).
      if (appData.returnKind === 'pgm' && Number.isInteger(resp.slot)) pgmOwnSlot = resp.slot;
      callback({ id: resp.producerId });
    }).catch(errback);
  });
  return sendTransport;
}

function setDisplayName(value) {
  displayName = (value || '').trim().slice(0, 30);
  localStorage.setItem('winus-display-name', displayName);
}

const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // Browsers (notably Chrome) can create/leave an AudioContext 'suspended'
  // when it's instantiated outside the synchronous call stack of a user
  // gesture (e.g. after an `await` inside a click handler, as happens in
  // selectStream()). A suspended context silently produces zero-valued
  // analyser reads (flat VU meters) WITHOUT affecting the unrelated native
  // <video> audio pipeline -- resume it eagerly, plus see the global click
  // listener below for a second chance if this attempt is itself blocked.
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

document.addEventListener('click', () => {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
});

// Monitor-only tap: connects a copy of the mic signal to an analyser so the
// VU meter can show its level, WITHOUT touching the actual track that gets
// sent to the publisher (that track is used raw, unmodified).
function tapAnalyser(stream) {
  const ctx = getAudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  return analyser;
}

// Volume of the incoming audio (what arrives FROM the publisher), not the
// mic/return audio sent TO it. Applied straight to the <video> element.
function setPlaybackVolume(value) {
  playbackVolume = Math.min(1, Math.max(0, parseFloat(value) || 0));
  const video = document.getElementById('main-video');
  if (video) video.volume = playbackVolume;
}

// Ensures exactly the ONE producer needed for `kind` ('pgm' or 'talkback').
// Deliberately independent per kind (not "ensure both at once"): PGM can now
// fail with "PGM lleno" when all 3 slots are taken, and that must NOT block
// Talkback, which is a completely separate, always-available channel.
async function ensureReturnProducer(kind) {
  if (kind === 'pgm' && pgmProducer) return true;
  if (kind === 'talkback' && talkbackProducer) return true;
  try {
    await ensureSendTransport();
    // Explicit maxBitrate: without it, the browser's default WebRTC Opus
    // encoder picks a much lower bitrate for a plain voice-constrained track
    // (often ~32kbps) than the publisher's outgoing audio (128kbps, see
    // AUDIO_BITRATE in tools/publish.js), leaving return audio quality
    // asymmetric between the two directions for no real reason.
    const RETURN_AUDIO_MAX_BITRATE = 128000;
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    try {
      const analyser = tapAnalyser(stream);
      const producer = await sendTransport.produce({
        track: stream.getAudioTracks()[0],
        // displayName only matters for PGM (shown per-slot in the admin panel);
        // Talkback stays anonymous there, so omit it to avoid confusion.
        appData: { returnKind: kind, displayName: kind === 'pgm' ? displayName : undefined },
        encodings: [{ maxBitrate: RETURN_AUDIO_MAX_BITRATE }],
      });
      await producer.pause();
      if (kind === 'pgm') {
        pgmProducer = producer; pgmAnalyser = analyser;
        // Cross-monitor: pick up any commentators already active on this
        // stream. pgmOwnSlot was already set (see ensureSendTransport's
        // 'produce' handler above, which resolves before sendTransport.produce()
        // returns here), so we correctly skip our own slot.
        for (let slot = 0; slot < PGM_MAX_SLOTS; slot++) {
          if (slot !== pgmOwnSlot) consumePgmPeerSlot(slot);
        }
      }
      else { talkbackProducer = producer; talkbackAnalyser = analyser; }
    } catch (err) {
      // Stop the already-granted mic tracks on failure (e.g. "PGM lleno"):
      // otherwise the mic stays "in use" in the browser/OS indicator for no
      // reason, even though no producer was actually created.
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }
    return true;
  } catch (err) {
    console.error(`No se pudo activar ${kind === 'pgm' ? 'Mic' : 'Talkback'}:`, err);
    // "PGM lleno (3/3 activos)" comes straight from the server (see
    // produceReturnAudio in mediasoup-manager.js) -- show it as-is instead of
    // the generic "no microphone access" message, since the mic itself is
    // fine, there's just no free PGM slot left.
    const full = /PGM lleno/i.test(err.message || '');
    alert(full ? err.message : 'No se pudo acceder al micrófono: ' + err.message);
    return false;
  }
}

// Sets up a monitor-only mono tap on the publisher's incoming audio track.
// Never connected to any output, so it has zero effect on what's actually
// played/heard (that's governed solely by video.volume, see
// setPlaybackVolume()) -- this purely reads the level of what arrived.
function setupIncomingVuMeter(audioTrack) {
  teardownIncomingVuMeter();
  const meterEl = document.getElementById('vu-meter-incoming');
  if (!audioTrack) return;
  try {
    const ctx = getAudioCtx();
    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    incomingSourceNode = source;
    incomingAnalyser = analyser;
    if (meterEl) meterEl.style.display = 'flex';
  } catch (err) {
    console.warn('No se pudo iniciar el vúmetro de entrada:', err);
  }
}

function teardownIncomingVuMeter() {
  try { incomingSourceNode?.disconnect(); } catch (_) {}
  incomingSourceNode = null;
  incomingAnalyser = null;
  const meterEl = document.getElementById('vu-meter-incoming');
  if (meterEl) meterEl.style.display = 'none';
}

// Drives both VU meters (return-audio on the right, incoming-audio on the
// left; both mono, segmented-LED style) from a single rAF loop. Runs
// continuously (checks for active analysers every frame) rather than being
// started/stopped per toggle/stream-change, which keeps this simple and
// self-correcting regardless of how state changes.
function vuRms(analyser, buf) {
  analyser.getByteTimeDomainData(buf);
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / buf.length);
}

// Converts an RMS amplitude (0..~1) to a 0-100% meter reading on a dB scale.
// A plain "rms * constant" linear scale (the previous approach) barely moves
// for typical mic/program levels, since RMS for normal speech/music sits
// well under 1.0 -- human hearing (and every real VU/PPM meter) works
// logarithmically, so converting to dB first and mapping a realistic
// dB window to 0-100% makes normal levels swing across most of the meter
// instead of hugging the bottom.
const VU_MIN_DB = -50; // treated as 0% (near silence/room noise)
const VU_MAX_DB = -8;  // treated as 100% (hot but pre-clipping)
function vuLevelPercent(analyser, buf) {
  const rms = vuRms(analyser, buf);
  if (rms <= 0.0001) return 0; // avoid -Infinity dB for true silence
  const db = 20 * Math.log10(rms);
  return dbLevelToPercent(db);
}

// Same dB->percent mapping as vuLevelPercent, but for a level already
// expressed in dBov (as reported by mediasoup's AudioLevelObserver via the
// 'pgmLevels' push -- see handleMessage) instead of derived from a local
// analyser buffer.
function dbLevelToPercent(db) {
  if (db === null || db === undefined) return 0;
  const pct = ((db - VU_MIN_DB) / (VU_MAX_DB - VU_MIN_DB)) * 100;
  return Math.max(0, Math.min(100, pct));
}

// Lazily builds the fixed stack of <div class="vu-segment"> children for a
// meter container (see the #vu-meter/#vu-meter-incoming CSS) and caches the
// resulting element list on the container itself, so this only runs once
// per container regardless of how many times the meter is (re)rendered.
// `segmentCount` only matters the FIRST time a given container is built
// (e.g. the admin per-slot meters use ADMIN_VU_SEGMENT_COUNT for finer
// resolution than the default, smaller on-video meter).
const VU_SEGMENT_COUNT = 10;
const ADMIN_VU_SEGMENT_COUNT = 20;
function getVuSegments(containerId, segmentCount = VU_SEGMENT_COUNT) {
  const el = document.getElementById(containerId);
  if (!el) return [];
  if (!el._vuSegments) {
    const frag = document.createDocumentFragment();
    const segments = [];
    for (let i = 0; i < segmentCount; i++) {
      const seg = document.createElement('div');
      seg.className = 'vu-segment';
      frag.appendChild(seg);
      segments.push(seg);
    }
    el.appendChild(frag);
    el._vuSegments = segments;
  }
  return el._vuSegments;
}

// Renders pct (0-100) onto a segment stack: segments light up from the
// bottom (index 0, since the container is flex-direction: column-reverse)
// up to the segment matching the current level, colored green/orange/red
// by each segment's own position in the stack (like a hardware meter),
// rather than by the overall level -- so the top red segments only ever
// light up red, never green.
function renderSegmentedMeter(segments, pct) {
  const total = segments.length;
  const litCount = Math.round((pct / 100) * total);
  for (let i = 0; i < total; i++) {
    const seg = segments[i];
    seg.classList.remove('lit-green', 'lit-orange', 'lit-red');
    if (i < litCount) {
      const posPct = ((i + 1) / total) * 100;
      seg.classList.add(posPct > 80 ? 'lit-red' : posPct > 60 ? 'lit-orange' : 'lit-green');
    }
  }
}

function startVuMeterLoop() {
  const buf = new Uint8Array(512);
  const bufIncoming = new Uint8Array(512);
  const bufPeer = new Uint8Array(512);
  const returnSegments = getVuSegments('vu-meter');
  function frame() {
    const analyser = talkbackOn ? talkbackAnalyser : (micOn ? pgmAnalyser : null);
    renderSegmentedMeter(returnSegments, analyser ? vuLevelPercent(analyser, buf) : 0);
    // Looked up fresh every frame (not cached like returnSegments above)
    // since #vu-meter-incoming/#peer-vu-<slot> live inside sidebar boxes
    // that get rebuilt (innerHTML) by renderPeerSidebar -- getVuSegments
    // self-heals by rebuilding its segment cache on whatever element
    // currently has that id.
    const incomingSegments = getVuSegments('vu-meter-incoming');
    if (incomingSegments.length) renderSegmentedMeter(incomingSegments, incomingAnalyser ? vuLevelPercent(incomingAnalyser, bufIncoming) : 0);
    for (const [slot, entry] of pgmPeerAudioEls) {
      if (!entry.analyser) continue;
      const peerSegments = getVuSegments(`peer-vu-${slot}`);
      if (peerSegments.length) renderSegmentedMeter(peerSegments, vuLevelPercent(entry.analyser, bufPeer));
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// Besides muting the local track (mediasoup-client's Producer.pause()),
// explicitly tell the server to pause/resume the actual mediasoup Producer.
// mediasoup-client does NOT do this on its own (it only relies on the
// browser sending silence for a disabled track), so without this the
// server-side Producer never truly stops — any hiccup in that local-silence
// behavior (or a publisher-side audio loopback) can leak real mic audio.
function notifyReturnState(kind, paused) {
  request(paused ? 'pauseReturn' : 'resumeReturn', { kind }).catch((err) =>
    console.error(`No se pudo ${paused ? 'pausar' : 'reanudar'} ${kind} en el servidor:`, err));
}

function applyPgmState() {
  if (!pgmProducer) return;
  if (micOn && !talkbackOn && !peerTalkOn) { pgmProducer.resume(); notifyReturnState('pgm', false); }
  else { pgmProducer.pause(); notifyReturnState('pgm', true); }
  updateReturnAudioUI(); // Talkback toggling PGM's actual on/off state must refresh the Mic button + tally too
}

// Mic (PGM) and Talkback are mutually exclusive latch buttons: activating
// one always ends the other first (no restore -- see toggleTalkback below),
// and clicking an already-active one just turns it off, leaving BOTH off
// rather than falling back to whatever was active before.
async function toggleMic() {
  if (!activeStreamId) return;
  if (micOn) {
    micOn = false;
    applyPgmState();
    updateReturnAudioUI();
    return;
  }
  if (talkbackOn) {
    talkbackOn = false;
    try { talkbackProducer?.pause(); } catch (_) {}
    notifyReturnState('talkback', true);
  }
  if (!(await ensureReturnProducer('pgm'))) return;
  micOn = true;
  applyPgmState();
  updateReturnAudioUI();
}

// Talkback is a latch (click to start, click again to stop), NOT push-to-talk.
// Mutually exclusive with Mic (see toggleMic above): starting Talkback always
// ends Mic first, and ending Talkback (by clicking it again) never resumes
// Mic automatically -- it just leaves PGM off too, per the mutual-exclusion
// design above.
async function toggleTalkback() {
  if (!activeStreamId) return;
  if (talkbackOn) {
    talkbackOn = false;
    try { talkbackProducer?.pause(); } catch (_) {}
    notifyReturnState('talkback', true);
    micOn = false;
    applyPgmState();
    updateReturnAudioUI();
    return;
  }
  micOn = false;
  applyPgmState();
  if (!(await ensureReturnProducer('talkback'))) return;
  talkbackOn = true;
  talkbackProducer.resume();
  notifyReturnState('talkback', false);
  updateReturnAudioUI();
}

// Safety net for the admin-talk push-to-talk button (and the admin panel's
// volume-slider hold-render guard) so it can never stay "stuck on": a
// mouseup/touchend landing outside the original button (finger/pointer slid
// off while held, or the DOM node got replaced mid-press by a re-render)
// would otherwise never reach that element's own onmouseup handler at all.
// Harmless no-ops when nothing is currently held. window 'blur' additionally
// covers alt-tabbing away, or the OS/browser stealing focus, while held
// down. NOTE: peerTalk is now a click-to-latch toggle (see togglePeerTalk),
// not press-and-hold, so it deliberately does NOT get reset here -- same as
// Mic/Talkback, it stays on until explicitly toggled off.
document.addEventListener('mouseup', () => { stopAdminTalk(); adminPanelHoldEnd(); });
document.addEventListener('touchend', () => { stopAdminTalk(); adminPanelHoldEnd(); });
document.addEventListener('touchcancel', () => { stopAdminTalk(); adminPanelHoldEnd(); });
window.addEventListener('blur', () => { stopAdminTalk(); adminPanelHoldEnd(); });

function updateReturnAudioUI() {
  const micBtn = document.getElementById('btn-mic');
  const tbBtn = document.getElementById('btn-talkback');
  if (!micBtn || !tbBtn) return;
  // PGM is only ACTUALLY on when the operator turned it on AND neither
  // Talkback nor a guest-to-guest PTT talk is overriding it (see
  // applyPgmState) -- the button must reflect that real state, not just
  // "the operator wants it on", so it visibly turns off while either is
  // active and comes back the moment they end.
  const pgmActuallyOn = micOn && !talkbackOn && !peerTalkOn;
  micBtn.classList.toggle('active', pgmActuallyOn);
  micBtn.title = talkbackOn ? 'Mic OFF (Talkback activo)' : peerTalkOn ? 'Mic OFF (hablando con otro comentarista)' : (micOn ? 'Mic ON' : 'Mic OFF');
  tbBtn.classList.toggle('active', talkbackOn);
  // Tally border around the video, mirrors whichever return-audio channel is live.
  const container = document.getElementById('video-container');
  if (container) {
    container.classList.toggle('tally-pgm', pgmActuallyOn);
    container.classList.toggle('tally-talkback', talkbackOn);
  }
}

// Show/hide the Mic (PGM) / Talkback buttons individually based on the
// publisher's stream metadata (see tools/publish.js's PGM_ENABLED/
// TALKBACK_ENABLED, set via the "Retorno" dialog's "Deshabilitado" option).
// Missing metadata (older publisher builds) defaults to showing both, for
// backward compatibility.
// NOTE: this only governs the RETURN-audio affordances (Mic/Talkback
// buttons, their container, and the #vu-meter showing the return audio's
// OWN level) -- it must NOT touch the incoming-audio VU meter or the
// "Retorno" fader (#retorno-box), since those apply to what's arriving FROM
// the publisher and are equally relevant for admin and regular logged-in
// viewers, not just guest links. Those two are governed solely by whether
// the stream actually carries audio (see selectStream's
// hasAudio/setupIncomingVuMeter).
function updateReturnAudioAvailability(metadata) {
  const micBtn = document.getElementById('btn-mic');
  const tbBtn = document.getElementById('btn-talkback');
  const container = document.getElementById('return-audio-controls');
  const vuMeter = document.getElementById('vu-meter');
  // Display-name input moved out to #video-controls-bar (see index.html)
  // when Mic/Talkback moved back inside the video, but it should still
  // hide/show together with them (same anyAvailable condition as before),
  // since it only matters while this commentator can actually appear in a
  // PGM slot.
  const nameWrap = document.getElementById('display-name-wrap');
  // Mic (PGM) and Talkback are now ONLY ever used by someone holding a
  // guest link (see startGuestViewer/streamLocked) for that ONE specific
  // stream/slot -- each commentator gets their own link, so there's no
  // longer any reason for a regular logged-in viewer OR an admin to talk
  // directly from the main server UI at all. Admins instead reach each
  // commentator individually via the per-slot "talk" button in the admin
  // panel (see startAdminTalk), which is a completely separate mechanism.
  // Also enforced server-side (see the 'produceReturn' WS case), this just
  // keeps the buttons from even appearing for non-guest sessions.
  const isGuestLink = streamLocked;
  const pgmAvailable = isGuestLink && (!metadata || metadata.pgmEnabled !== false);
  const talkbackAvailable = isGuestLink && (!metadata || metadata.talkbackEnabled !== false);
  const anyAvailable = pgmAvailable || talkbackAvailable;
  if (micBtn) micBtn.style.display = pgmAvailable ? 'inline-block' : 'none';
  if (tbBtn) tbBtn.style.display = talkbackAvailable ? 'inline-block' : 'none';
  if (container) container.style.display = anyAvailable ? 'flex' : 'none';
  if (vuMeter) vuMeter.style.display = anyAvailable ? 'flex' : 'none';
  if (nameWrap) nameWrap.style.display = anyAvailable ? 'flex' : 'none';
}

// Cross-monitor: consume + play one other active PGM speaker's audio over
// our existing recvTransport (`transport`, already used for the main video/
// audio subscription -- no separate transport needed). Safe to call for a
// slot that's already being monitored (replaces it) or currently empty
// (server responds {empty:true}, which just tears down any stale entry).
async function consumePgmPeerSlot(slot) {
  if (!activeStreamId || !transport) return;
  try {
    const result = await request('consumePgmPeer', { streamId: activeStreamId, slot });
    stopPgmPeerSlot(slot); // drop any previous consumer/element for this slot first
    if (!result || result.empty) { renderPeerSidebar(); return; }
    const consumer = await transport.consume({
      id: result.id, producerId: result.producerId,
      kind: result.kind, rtpParameters: result.rtpParameters,
    });
    await request('resumeConsumer', { consumerId: consumer.id });
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.style.display = 'none';
    // Re-apply whatever volume WE previously set for this slot (see
    // renderPeerSidebar) -- otherwise a brief reconnect of that peer would
    // silently reset our own adjustment back to 100%.
    audioEl.volume = pgmPeerVolumes.has(slot) ? pgmPeerVolumes.get(slot) : 1;
    audioEl.srcObject = new MediaStream([consumer.track]);
    document.body.appendChild(audioEl);
    audioEl.play().catch(() => {
      // Same autoplay-block workaround as the AudioContext resume above --
      // retry once on the next user gesture.
      const retry = () => { audioEl.play().catch(() => {}); document.removeEventListener('click', retry); };
      document.addEventListener('click', retry);
    });
    // Monitor-only tap (see tapAnalyser) so the peer's sidebar box can show
    // its own VU meter (see startVuMeterLoop) -- purely a level reading,
    // never connected to any output (the actual playback is audioEl above).
    let analyser = null, analyserSource = null;
    try {
      const ctx = getAudioCtx();
      analyserSource = ctx.createMediaStreamSource(new MediaStream([consumer.track]));
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyserSource.connect(analyser);
    } catch (err) {
      console.warn(`No se pudo iniciar el vúmetro del comentarista del slot ${slot}:`, err);
    }
    pgmPeerAudioEls.set(slot, { consumer, audioEl, analyser, analyserSource });
    renderPeerSidebar();
  } catch (err) {
    console.error(`No se pudo escuchar al comentarista del slot ${slot}:`, err);
  }
}

function stopPgmPeerSlot(slot) {
  const entry = pgmPeerAudioEls.get(slot);
  if (!entry) return;
  try { entry.consumer.close(); } catch (_) {}
  try { entry.audioEl.pause(); entry.audioEl.srcObject = null; entry.audioEl.remove(); } catch (_) {}
  try { entry.analyserSource?.disconnect(); } catch (_) {}
  pgmPeerAudioEls.delete(slot);
  renderPeerSidebar();
}

function stopAllPgmPeerAudio() {
  for (const slot of Array.from(pgmPeerAudioEls.keys())) stopPgmPeerSlot(slot);
}

function setPgmPeerVolume(slot, value) {
  value = Math.min(1, Math.max(0, value));
  pgmPeerVolumes.set(slot, value);
  const entry = pgmPeerAudioEls.get(slot);
  if (entry) entry.audioEl.volume = value;
}

// Admin -> viewer private talk (admin side): push-to-talk (mousedown/mouseup
// in the admin panel, unlike the viewer's own Mic/Talkback latch buttons
// above). Only one slot at a time per admin -- pressing a different slot's
// button while already talking closes the previous producer first (see
// produceAdminTalk's "last one wins").
async function startAdminTalk(streamId, slot) {
  if (adminTalkPressed) return;
  adminTalkPressed = true;
  try {
    await ensureSendTransport();
    const localStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    if (!adminTalkPressed) { localStream.getTracks().forEach(t => t.stop()); return; } // released mid-setup
    const producer = await sendTransport.produce({
      track: localStream.getAudioTracks()[0],
      appData: { returnKind: 'adminTalk', streamId, slot },
      encodings: [{ maxBitrate: 128000 }],
    });
    producer._localStream = localStream;
    adminTalkProducer = producer;
    if (!adminTalkPressed) stopAdminTalk(); // released mid-setup, after the producer was already created
  } catch (err) {
    console.error('No se pudo hablar con el comentarista:', err);
    adminTalkPressed = false;
  }
}

function stopAdminTalk() {
  adminTalkPressed = false;
  if (!adminTalkProducer) return;
  try { adminTalkProducer._localStream?.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { adminTalkProducer.close(); } catch (_) {}
  adminTalkProducer = null;
}

// Guest -> guest Latch talk (see togglePeerTalk, the actual click handler --
// this lower-level function is invoked from there, never bound to a raw
// mousedown/touchstart anymore): unlike startAdminTalk/startTalkback, this
// must PAUSE our own PGM (if we have one) while talking and RESTORE it to
// its pre-talk on/off state once stopped -- see peerTalkOn's comment above
// and applyPgmState(), which already does exactly that once peerTalkOn is
// toggled, no manual state stashing needed. Only one target at a time --
// togglePeerTalk() stops the previous one before starting a new target (see
// its own comment); the server also enforces "last one wins" regardless
// (see producePeerTalk).
async function startPeerTalk(slot) {
  if (peerTalkPressed || !activeStreamId) return;
  peerTalkPressed = true;
  peerTalkTargetSlot = slot;
  peerTalkOn = true;
  applyPgmState(); // pause our own PGM immediately, restored on release
  updatePeerTalkButtons(); // reflect the new active target right away, don't wait on the network
  try {
    await ensureSendTransport();
    const localStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    if (!peerTalkPressed) { localStream.getTracks().forEach(t => t.stop()); return; } // released mid-setup
    const producer = await sendTransport.produce({
      track: localStream.getAudioTracks()[0],
      appData: { returnKind: 'peerTalk', streamId: activeStreamId, targetSlot: slot },
      encodings: [{ maxBitrate: 128000 }],
    });
    producer._localStream = localStream;
    peerTalkProducer = producer;
    if (!peerTalkPressed) stopPeerTalk(); // released mid-setup, after the producer was already created
  } catch (err) {
    console.error('No se pudo hablar con el otro comentarista:', err);
    peerTalkPressed = false;
    peerTalkOn = false;
    applyPgmState();
    updatePeerTalkButtons();
  }
}

function stopPeerTalk() {
  if (!peerTalkPressed && !peerTalkProducer) return;
  peerTalkPressed = false;
  peerTalkTargetSlot = null;
  peerTalkOn = false;
  applyPgmState(); // restore PGM to whatever it was right before the press
  updatePeerTalkButtons();
  if (!peerTalkProducer) return;
  try { peerTalkProducer._localStream?.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { peerTalkProducer.close(); } catch (_) {}
  peerTalkProducer = null;
}

// Click handler for each peer sidebar box's "Hablar" button (see
// renderPeerSidebar): clicking the currently-active target's own button
// stops it (toggle off); clicking a DIFFERENT target while already talking
// switches directly to it (stop the old one first -- startPeerTalk() is a
// no-op while peerTalkPressed is already true, so skipping the stop here
// would silently swallow the new target); clicking with nothing active
// simply starts talking to that target.
function togglePeerTalk(slot) {
  if (peerTalkOn && peerTalkTargetSlot === slot) { stopPeerTalk(); return; }
  if (peerTalkOn) stopPeerTalk();
  startPeerTalk(slot);
}

// Admin -> viewer private talk (receiving viewer's side): plays whichever
// admin is currently talking to us over our existing recvTransport, same
// hidden-<audio> pattern as the PGM cross-monitor above.
async function consumeAdminTalkAudio() {
  if (!transport) return;
  try {
    const result = await request('consumeAdminTalk');
    stopAdminTalkAudio();
    if (!result || result.empty) return;
    const consumer = await transport.consume({
      id: result.id, producerId: result.producerId,
      kind: result.kind, rtpParameters: result.rtpParameters,
    });
    await request('resumeConsumer', { consumerId: consumer.id });
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.style.display = 'none';
    audioEl.srcObject = new MediaStream([consumer.track]);
    document.body.appendChild(audioEl);
    audioEl.play().catch(() => {
      const retry = () => { audioEl.play().catch(() => {}); document.removeEventListener('click', retry); };
      document.addEventListener('click', retry);
    });
    adminTalkAudio = { consumer, audioEl };
  } catch (err) {
    console.error('No se pudo escuchar al administrador:', err);
  }
}

function stopAdminTalkAudio() {
  if (!adminTalkAudio) return;
  try { adminTalkAudio.consumer.close(); } catch (_) {}
  try { adminTalkAudio.audioEl.pause(); adminTalkAudio.audioEl.srcObject = null; adminTalkAudio.audioEl.remove(); } catch (_) {}
  adminTalkAudio = null;
}

// Guest -> guest push-to-talk (receiving end): plays whichever fellow
// commentator is currently PTT-talking to us, over our existing
// recvTransport. Same hidden-<audio> pattern as consumeAdminTalkAudio.
async function consumePeerTalkAudio() {
  if (!transport) return;
  try {
    const result = await request('consumePeerTalk');
    stopPeerTalkAudio();
    if (!result || result.empty) return;
    const consumer = await transport.consume({
      id: result.id, producerId: result.producerId,
      kind: result.kind, rtpParameters: result.rtpParameters,
    });
    await request('resumeConsumer', { consumerId: consumer.id });
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.style.display = 'none';
    audioEl.srcObject = new MediaStream([consumer.track]);
    document.body.appendChild(audioEl);
    audioEl.play().catch(() => {
      const retry = () => { audioEl.play().catch(() => {}); document.removeEventListener('click', retry); };
      document.addEventListener('click', retry);
    });
    peerTalkAudio = { consumer, audioEl };
  } catch (err) {
    console.error('No se pudo escuchar al otro comentarista:', err);
  }
}

function stopPeerTalkAudio() {
  if (!peerTalkAudio) return;
  try { peerTalkAudio.consumer.close(); } catch (_) {}
  try { peerTalkAudio.audioEl.pause(); peerTalkAudio.audioEl.srcObject = null; peerTalkAudio.audioEl.remove(); } catch (_) {}
  peerTalkAudio = null;
}

// Viewer -> admin Talkback (admin side): plays whichever viewer is currently
// holding Talkback on `streamId`, over the admin's own recvTransport (`transport`,
// already used for the main video/audio subscription). Same hidden-<audio>
// pattern as consumeAdminTalkAudio/consumePgmPeerSlot above. Independent of
// the publisher's own consumeReturnAudio -- this is purely additive.
async function consumeTalkbackFromViewer(streamId) {
  if (!transport) return;
  try {
    const result = await request('consumeTalkback', { streamId });
    stopTalkbackFromViewer(streamId);
    if (!result || result.empty) return;
    const consumer = await transport.consume({
      id: result.id, producerId: result.producerId,
      kind: result.kind, rtpParameters: result.rtpParameters,
    });
    await request('resumeConsumer', { consumerId: consumer.id });
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.style.display = 'none';
    audioEl.srcObject = new MediaStream([consumer.track]);
    document.body.appendChild(audioEl);
    audioEl.play().catch(() => {
      const retry = () => { audioEl.play().catch(() => {}); document.removeEventListener('click', retry); };
      document.addEventListener('click', retry);
    });
    talkbackFromViewerAudioEls.set(streamId, { consumer, audioEl });
  } catch (err) {
    console.error(`No se pudo escuchar el Talkback del stream ${streamId}:`, err);
  }
}

function stopTalkbackFromViewer(streamId) {
  const entry = talkbackFromViewerAudioEls.get(streamId);
  if (!entry) return;
  try { entry.consumer.close(); } catch (_) {}
  try { entry.audioEl.pause(); entry.audioEl.srcObject = null; entry.audioEl.remove(); } catch (_) {}
  talkbackFromViewerAudioEls.delete(streamId);
}

function stopAllTalkbackFromViewer() {
  for (const streamId of Array.from(talkbackFromViewerAudioEls.keys())) stopTalkbackFromViewer(streamId);
}

// Admin PGM "listen" (monitor-only): toggled per-stream from a button next to
// each stream's PGM box (see renderAdminStreamsList). Only one stream at a
// time -- switching to a different one (or a talkback call coming in, see
// handleMessage's 'talkbackAudioChanged') stops whichever was playing first.
async function togglePgmListen(streamId) {
  if (pgmListenStreamId === streamId) { stopPgmListen(); return; }
  stopPgmListen();
  pgmListenStreamId = streamId;
  renderAdminStreamsList(); // reflect "listening" state on the button right away
  const s = lastStreams.find(x => x.streamId === streamId);
  const slots = s?.pgmSlots || [];
  for (let slot = 0; slot < slots.length; slot++) {
    if (slots[slot]) await consumePgmListenSlot(streamId, slot);
  }
}

function stopPgmListen() {
  if (!pgmListenStreamId) return;
  pgmListenStreamId = null;
  for (const slot of Array.from(pgmListenAudioEls.keys())) stopPgmListenSlot(slot);
  renderAdminStreamsList();
}

// Reuses the same 'consumePgmPeer' request as the PGM cross-monitor feature
// (consumePgmPeerAudio server-side) -- an admin is never itself a PGM
// speaker, so there's no "own slot" to skip there. Safe to call for a slot
// that's already being monitored (replaces it) or currently empty (server
// responds {empty:true}, which just tears down any stale entry).
async function consumePgmListenSlot(streamId, slot) {
  if (pgmListenStreamId !== streamId || !transport) return;
  try {
    const result = await request('consumePgmPeer', { streamId, slot });
    stopPgmListenSlot(slot);
    if (pgmListenStreamId !== streamId) return; // switched away while this was in flight
    if (!result || result.empty) return;
    const consumer = await transport.consume({
      id: result.id, producerId: result.producerId,
      kind: result.kind, rtpParameters: result.rtpParameters,
    });
    await request('resumeConsumer', { consumerId: consumer.id });
    if (pgmListenStreamId !== streamId) { try { consumer.close(); } catch (_) {} return; }
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.style.display = 'none';
    audioEl.srcObject = new MediaStream([consumer.track]);
    document.body.appendChild(audioEl);
    audioEl.play().catch(() => {
      const retry = () => { audioEl.play().catch(() => {}); document.removeEventListener('click', retry); };
      document.addEventListener('click', retry);
    });
    pgmListenAudioEls.set(slot, { consumer, audioEl });
  } catch (err) {
    console.error(`No se pudo escuchar el PGM (slot ${slot}) del stream ${streamId}:`, err);
  }
}

function stopPgmListenSlot(slot) {
  const entry = pgmListenAudioEls.get(slot);
  if (!entry) return;
  try { entry.consumer.close(); } catch (_) {}
  try { entry.audioEl.pause(); entry.audioEl.srcObject = null; entry.audioEl.remove(); } catch (_) {}
  pgmListenAudioEls.delete(slot);
}

function resetReturnAudio() {
  try { pgmProducer?.close(); } catch (_) {}
  try { talkbackProducer?.close(); } catch (_) {}
  pgmProducer = null;
  talkbackProducer = null;
  pgmAnalyser = null;
  talkbackAnalyser = null;
  micOn = false;
  talkbackOn = false;
  stopAllPgmPeerAudio();
  stopAdminTalkAudio();
  stopPeerTalk();
  stopPeerTalkAudio();
  pgmOwnSlot = null;
  updateReturnAudioUI();
}

function toggleFullscreen() {
  const c = document.getElementById('video-container');
  if (document.fullscreenElement) document.exitFullscreen();
  else c.requestFullscreen().catch(() => {});
}

// Mic/Talkback (#return-audio-controls) normally live inline inside
// #video-controls-bar, alongside Name/stream name/g2g/Fullscreen -- that's
// their correct, "bien situado" position in normal viewing. But the
// Fullscreen API (see toggleFullscreen above) only ever fullscreens
// #video-container, so anything left behind in #video-controls-bar
// (a sibling) simply disappears the moment fullscreen is entered. To keep
// Mic/Talkback usable while fullscreen, physically move that one element
// INTO #video-container (as a bottom-right overlay, see .return-audio-fs)
// on the way in, and back out to its normal spot in the bar on the way out.
// Nothing else in the bar moves -- Name/stream name/g2g/Fullscreen are
// meant to disappear in fullscreen, only Mic/Talkback are the exception.
document.addEventListener('fullscreenchange', () => {
  const videoContainer = document.getElementById('video-container');
  const controls = document.getElementById('return-audio-controls');
  // Normal home: last child of .controls-bar-right, right after the name
  // input, so the on-screen order reads Name, Mic, Talkback (see index.html).
  const rightGroup = document.querySelector('.controls-bar-right');
  if (!videoContainer || !controls || !rightGroup) return;
  if (document.fullscreenElement === videoContainer) {
    videoContainer.appendChild(controls);
    controls.classList.add('return-audio-fs');
  } else {
    rightGroup.appendChild(controls);
    controls.classList.remove('return-audio-fs');
  }
});

// ── Audio jitter buffer ──
// Only affects the incoming audio track's RTCRtpReceiver, not video, so
// video keeps its normal buffering.
function applyAudioBufferTarget() {
  const audioConsumer = activeConsumers.find(c => c.track && c.track.kind === 'audio');
  const receiver = audioConsumer?.rtpReceiver;
  if (!receiver) return;
  try {
    if ('jitterBufferTarget' in receiver) {
      // Newer standard API: target buffer in milliseconds.
      receiver.jitterBufferTarget = AUDIO_BUFFER_MS;
    } else if ('playoutDelayHint' in receiver) {
      // Older Chrome API: target delay in seconds.
      receiver.playoutDelayHint = AUDIO_BUFFER_MS / 1000;
    }
  } catch (err) {
    console.warn('No se pudo ajustar el buffer de audio:', err);
  }
}

// ── Admin panel ──
function toggleAdmin() {
  const p = document.getElementById('admin-panel');
  const isAdmin = ['admin', 'superadmin'].includes(userRole);
  // User Management (create/delete users, Reset Server) stays strictly
  // admin/superadmin-only -- a 'publisher' only ever gets this panel open
  // to reach the Streams list's guest-link buttons (see
  // renderAdminStreamsList's per-role gating below).
  const userMgmt = document.getElementById('user-mgmt-panel');
  if (userMgmt) userMgmt.style.display = isAdmin ? 'block' : 'none';
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
  if (p.style.display === 'block') {
    if (isAdmin) loadUsers();
    renderAdminStreamsList();
  }
}

// Belt-and-suspenders: re-render the admin "Streams" panel (PGM slots,
// Talkback light) every few seconds while it's visible, on top of the
// normal event-driven re-renders (see renderStreamList/broadcastStreams).
// Cheap (just redraws from the already-received lastStreams, no network
// call) and guards against ever missing a single WS push leaving the panel
// looking frozen/stale.
setInterval(() => {
  const p = document.getElementById('admin-panel');
  if (p && p.style.display === 'block') renderAdminStreamsList();
}, 3000);

const PGM_MAX_SLOTS = 3;

// Per-stream PGM slot rows: user (or "Libre"), a volume slider (setPgmVolume),
// a segmented VU meter fed by the 'pgmLevels' push (see handleMessage), and a
// push-to-talk button letting the admin speak PRIVATELY to that one
// commentator (see startAdminTalk/stopAdminTalk) -- separate from, and NOT a
// substitute for, the admin's own regular Talkback-to-publisher button.
function renderPgmSlots(s) {
  const slots = s.pgmSlots || new Array(PGM_MAX_SLOTS).fill(null);
  const anyActive = slots.some(Boolean);
  const rows = slots.map((slot, i) => {
    const label = slot ? (slot.user || 'Hablante') : 'Libre';
    const volumePct = Math.round((slot ? (slot.volume ?? 1) : 1) * 100);
    const vuId = `pgm-vu-${s.streamId}-${i}`;
    const talkHandlers = slot
      ? `onmousedown="adminPanelHoldStart(); startAdminTalk('${s.streamId}', ${i})" ` +
        `onmouseup="adminPanelHoldEnd(); stopAdminTalk()" onmouseleave="adminPanelHoldEnd(); stopAdminTalk()" ` +
        `ontouchstart="event.preventDefault(); adminPanelHoldStart(); startAdminTalk('${s.streamId}', ${i})" ` +
        `ontouchend="event.preventDefault(); adminPanelHoldEnd(); stopAdminTalk()"`
      : '';
    // Per-commentator Talkback LED: lit only when THIS slot's occupant
    // (matched by peerId, not by display name -- names can repeat/be blank)
    // is the one currently, actively speaking on Talkback (see
    // talkbackActive/talkbackPeerId in getActiveStreams) -- not just "has it
    // open" (stays true, paused, for their whole session).
    const talkbackLit = !!(slot && s.talkbackActive && slot.peerId && slot.peerId === s.talkbackPeerId);
    const talkbackDot = slot
      ? `<span class="talkback-led ${talkbackLit ? 'lit' : ''}" title="${talkbackLit ? 'Hablando por Talkback' : 'Talkback inactivo'}"></span>`
      : '';
    return `
    <div class="admin-pgm-slot">
      <span style="width:56px; color:#666680;">Slot ${i + 1}</span>
      <span style="flex:1; display:flex; align-items:center; gap:6px; ${slot ? '' : 'color:#666680; font-style:italic;'}">${talkbackDot}${label}</span>
      <div id="${vuId}" class="admin-vu-meter" title="Nivel PGM"></div>
      <input type="range" min="0" max="200" value="${volumePct}" ${slot ? '' : 'disabled'}
        onmousedown="adminPanelHoldStart()" onmouseup="adminPanelHoldEnd()"
        ontouchstart="adminPanelHoldStart()" ontouchend="adminPanelHoldEnd()"
        oninput="setPgmVolume('${s.streamId}', ${i}, this.value/100)" title="Volumen">
      <button type="button" class="btn-admin-talk" ${slot ? '' : 'disabled'} ${talkHandlers}
        title="Hablar en privado con este comentarista (mantener presionado)">🎙️ Hablar</button>
    </div>`;
  }).join('');
  // Whole-group "incoming call" box (see .admin-pgm-slots.talkback-active):
  // lit whenever ANYONE is actively on Talkback for this stream, on top of
  // the per-slot LED that already pinpoints exactly who.
  const callActive = s.talkbackActive ? ' talkback-active' : '';
  // "Hablar a los 3": same push-to-talk mechanism as the per-slot "Hablar"
  // button (startAdminTalk/stopAdminTalk), just targeting slot='all' so the
  // server fans the admin's mic out to EVERY currently active PGM speaker on
  // this stream at once (see produceAdminTalk). Disabled when nobody's on
  // PGM -- nothing to talk to.
  const talkAllHandlers = anyActive
    ? `onmousedown="adminPanelHoldStart(); startAdminTalk('${s.streamId}', 'all')" ` +
      `onmouseup="adminPanelHoldEnd(); stopAdminTalk()" onmouseleave="adminPanelHoldEnd(); stopAdminTalk()" ` +
      `ontouchstart="event.preventDefault(); adminPanelHoldStart(); startAdminTalk('${s.streamId}', 'all')" ` +
      `ontouchend="event.preventDefault(); adminPanelHoldEnd(); stopAdminTalk()"`
    : '';
  return `<div class="admin-pgm-slots${callActive}">
    <div style="display:flex; justify-content:flex-end; margin-bottom:6px;">
      <button type="button" class="btn-admin-talk-all" ${anyActive ? '' : 'disabled'} ${talkAllHandlers}
        title="Hablar a los 3 comentaristas a la vez (mantener presionado)">🎙️ Hablar a los 3</button>
    </div>
    ${rows}
  </div>`;
}

async function setPgmVolume(streamId, slot, volume) {
  try {
    await request('setPgmVolume', { streamId, slot, volume: parseFloat(volume) });
  } catch (err) {
    console.error('No se pudo ajustar el volumen PGM:', err);
  }
}

// Talkback status: shown as a per-commentator LED next to each PGM slot's
// name (see renderPgmSlots's talkbackDot) rather than one global line here,
// since a viewer/commentator occupying a slot is the normal case this is
// used for. This fallback line only appears for the (rarer) case where the
// current Talkback speaker ISN'T any of this stream's PGM slot occupants
// (e.g. a plain viewer with no PGM/Mic active at all) -- otherwise it stays
// empty, since the per-slot LED already covers it and a second, separate
// indicator for the same person would be redundant/confusing.
function renderTalkbackStatus(s) {
  if (!s.talkbackActive) return '';
  const inSomeSlot = Array.isArray(s.pgmSlots) && s.pgmSlots.some(slot => slot && slot.peerId === s.talkbackPeerId);
  if (inSomeSlot) return '';
  return `
    <div style="display:flex; align-items:center; gap:8px; font-size:12px; color:#666680; margin-top:6px;">
      <span style="width:11px; height:11px; border-radius:50%; display:inline-block; flex-shrink:0;
        background:#00e676; box-shadow:0 0 6px #00e676;"></span>
      <span>Talkback: ${s.talkbackUser || 'activo'}</span>
    </div>`;
}

// Connected guests (see signaling.js's withGuestPeers): one "❌ Desconectar"
// button per guest-link viewer currently attached to this stream. Labels
// with whatever displayName they're using in a PGM slot, if they're
// occupying one (see renderPgmSlots) -- otherwise falls back to a generic
// "Invitado" since every guest of the same stream shares the same generic
// peerUser string server-side ("guest:<streamId>").
function renderConnectedGuests(s) {
  const guests = s.guests || [];
  if (!guests.length) return '';
  const slots = s.pgmSlots || [];
  const rows = guests.map((g) => {
    const slot = slots.find((sl) => sl && sl.peerId === g.peerId);
    const label = slot?.user || 'Invitado';
    return `
    <div style="display:flex; align-items:center; gap:8px; padding:2px 0; font-size:12px;">
      <span style="flex:1; color:#a0a0b8;">\u{1F464} ${label}</span>
      <button type="button" onclick="disconnectGuest('${g.peerId}')"
        style="background:#ff5252; font-size:11px; padding:2px 8px;" title="Desconectar a este invitado">❌ Desconectar</button>
    </div>`;
  }).join('');
  return `
    <div style="margin-top:6px; padding-top:6px; border-top:1px dashed #333;">
      <div style="font-size:11px; color:#666680; margin-bottom:2px;">Invitados conectados (${guests.length})</div>
      ${rows}
    </div>`;
}

// Guest-link generation ("Copiar enlace"): reuses lastStreams (already kept
// up to date by renderStreamList/handleMessage) rather than a separate
// fetch, so this list matches whatever's currently live.
function renderAdminStreamsList() {
  const container = document.getElementById('admin-stream-list');
  if (!container) return;
  // Don't rebuild this panel's DOM while the admin is actively dragging a
  // volume slider or holding a "talk" button (see adminPanelHoldStart):
  // replacing those nodes mid-interaction breaks the browser's pointer
  // capture, which made the sliders feel completely unresponsive. The next
  // 'streams' push after release re-renders normally.
  if (adminPanelSuspendRender) return;
  if (!lastStreams.length) {
    container.innerHTML = '<div style="color:#666680; font-size:13px; padding:4px 0;">No active streams</div>';
    return;
  }
  // A 'publisher' account ("streamer") sees EVERY stream in this list (just
  // the name -- see GET /api/streams, unrestricted by role) but can only
  // MANAGE (guest link, PGM listen/volume/private talk, connected-guests
  // list) the ones it is CURRENTLY the live owner of, matched via
  // s.metadata.user (set server-side from its own login, see 'produce' in
  // signaling.js) against this browser's own logged-in username. admin/
  // superadmin can always manage every stream. Force-stop stays
  // admin/superadmin-only regardless of ownership (see canManageStream's
  // docs in signaling.js) -- it's more destructive than adjusting your own
  // stream's controls. Every check here is cosmetic only: the server
  // enforces the exact same rule again (see canManageStream in
  // signaling.js), so this can never be bypassed by tampering with the UI.
  const isAdmin = ['admin', 'superadmin'].includes(userRole);
  const isPublisher = userRole === 'publisher';
  container.innerHTML = lastStreams.map(s => {
    const label = s.streamName || s.streamId.replace('stream-', 'CH ');
    const canManage = isAdmin || (isPublisher && s.metadata?.user === currentUsername);
    // Admin/publisher PGM "listen" (monitor-only, see togglePgmListen): one
    // button per stream's box, since more than one may be manageable at once.
    const listening = pgmListenStreamId === s.streamId;
    const manageControls = canManage ? `
        <button type="button" class="btn-pgm-listen ${listening ? 'active' : ''}" onclick="togglePgmListen('${s.streamId}')"
          title="Escuchar el PGM de este stream (solo escucha, no habla)">${listening ? '🔊 Escuchando PGM' : '🔈 Escuchar PGM'}</button>` : '';
    const forceStopBtn = isAdmin ? `
        <button onclick="forceStopStream('${s.streamId}')" style="background:#ff5252; font-size:11px; padding:3px 10px;"
          title="Cierra este stream ahora mismo en el servidor, sin afectar a los demás (el publisher deberá volver a iniciarlo)">🛑 Forzar cierre</button>` : '';
    const linkButtons = canManage ? `
        <span class="link-status" data-stream="${s.streamId}" style="font-size:11px; color:#666680; min-width:140px;"></span>
        <button onclick="copyGuestLink('${s.streamId}')" style="background:#00c9db; color:#1a1a2e; font-size:11px; padding:3px 10px;">🔗 Copiar enlace</button>
        <button onclick="regenerateGuestLink('${s.streamId}')" style="background:#ffab40; color:#1a1a2e; font-size:11px; padding:3px 10px;"
          title="Genera un enlace nuevo; el viejo deja de servir para conectarse (no desconecta a quién ya está conectado)">🆕 New Link</button>` : '';
    // HLS link (WebOS/Smart TV): every logged-in role can generate/copy it
    // (see hlsLinkAuth server-side), unlike the guest link -- so this is
    // shown for EVERY stream row here, not just canManage ones.
    const hlsLinkButton = `
        <span class="hls-link-status" data-stream="${s.streamId}" style="font-size:11px; color:#666680; min-width:100px;"></span>
        <button onclick="copyHlsLink('${s.streamId}')" style="background:#7b2ff7; color:#fff; font-size:11px; padding:3px 10px;"
          title="Copiar enlace HLS (para reproducir en Smart TV/WebOS)">📺 Copiar HLS</button>`;
    return `
    <div style="padding:8px; border-bottom:1px solid #333;">
      <div style="display:flex; align-items:center; gap:10px;">
        <span style="flex:1; font-weight:bold;">${label}</span>${manageControls}
        ${linkButtons}${hlsLinkButton}${forceStopBtn}
      </div>
      ${canManage ? renderTalkbackStatus(s) : ''}
      ${canManage ? renderPgmSlots(s) : ''}
      ${canManage ? renderConnectedGuests(s) : ''}
    </div>`;
  }).join('');
}

// Admin "Forzar cierre": kills ONE stream on the server right now, unlike
// Reset Server (which nukes every stream/viewer) -- e.g. a publisher stuck
// disconnected ungracefully, occupying its channel with no way for anyone
// (including that same operator) to republish it without a full reset. See
// the WS 'forceUnpublish' handler in signaling.js.
async function forceStopStream(streamId) {
  if (!confirm(`¿Forzar el cierre del stream "${streamId}"?\n\nCorta la transmisión en el servidor ahora mismo; el resto de streams/viewers no se ven afectados. El publisher deberá volver a iniciarlo.`)) return;
  try {
    await request('forceUnpublish', { streamId });
  } catch (e) {
    alert(`No se pudo forzar el cierre: ${e.message}`);
  }
}

async function copyGuestLink(streamId) {
  const statusEl = document.querySelector(`.link-status[data-stream="${streamId}"]`);
  if (statusEl) statusEl.textContent = 'Generando...';
  try {
    const res = await apiCall('GET', `/api/streams/${encodeURIComponent(streamId)}/link`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (statusEl) statusEl.textContent = err.error || 'Stream no activo';
      return;
    }
    const { url } = await res.json();
    await navigator.clipboard.writeText(url);
    if (statusEl) {
      statusEl.textContent = '✓ Copiado';
      setTimeout(() => { if (statusEl.textContent === '✓ Copiado') statusEl.textContent = ''; }, 3000);
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = `Error: ${e.message}`;
  }
}

// HLS link (WebOS/Smart TV playback, see hls.html): unlike the guest link,
// EVERY logged-in role (admin/superadmin/publisher/viewer) can generate/copy
// it (see hlsLinkAuth server-side) -- a plain viewer gains no other new
// capability from this. Used both by #btn-hls-link (video-controls-bar, no
// per-stream status element) and by the admin panel's per-row button (which
// does have one, see .hls-link-status) -- falls back to briefly relabeling
// the button itself when no status element is found.
async function copyHlsLink(streamId) {
  if (!streamId) return;
  const statusEl = document.querySelector(`.hls-link-status[data-stream="${streamId}"]`);
  const btn = !statusEl ? document.getElementById('btn-hls-link') : null;
  const originalBtnText = btn ? btn.textContent : null;
  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
    else if (btn) btn.textContent = text;
  };
  const restoreBtn = (delay) => {
    if (btn) setTimeout(() => { btn.textContent = originalBtnText; }, delay);
  };
  setStatus(statusEl ? 'Generando...' : '⏳ HLS');
  try {
    const res = await apiCall('GET', `/api/streams/${encodeURIComponent(streamId)}/hls-link`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setStatus(statusEl ? (err.error || 'Stream no activo') : '✖ HLS');
      restoreBtn(2500);
      return;
    }
    const { url } = await res.json();
    await navigator.clipboard.writeText(url);
    setStatus(statusEl ? '✓ Copiado' : '✓ HLS');
    if (statusEl) setTimeout(() => { if (statusEl.textContent === '✓ Copiado') statusEl.textContent = ''; }, 3000);
    restoreBtn(2500);
  } catch (e) {
    setStatus(statusEl ? `Error: ${e.message}` : '✖ HLS');
    restoreBtn(2500);
  }
}

// Admin "New Link": rotates the guest key (see backend's regenerateStreamGuestLink)
// so the OLD link stops working for any FUTURE connection attempt. Does NOT
// disconnect whoever is already connected with the old link -- use the
// "❌ Desconectar" button per guest (see renderConnectedGuests) for that.
async function regenerateGuestLink(streamId) {
  if (!confirm('¿Generar un enlace nuevo para este stream?\n\nEl enlace viejo dejará de funcionar para NUEVAS conexiones, ' +
    'pero no desconecta a quien ya está conectado con él (usará el botón Desconectar para eso).')) return;
  const statusEl = document.querySelector(`.link-status[data-stream="${streamId}"]`);
  if (statusEl) statusEl.textContent = 'Generando...';
  try {
    const res = await apiCall('POST', `/api/streams/${encodeURIComponent(streamId)}/link/regenerate`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (statusEl) statusEl.textContent = err.error || 'Error';
      return;
    }
    const { url } = await res.json();
    await navigator.clipboard.writeText(url);
    if (statusEl) {
      statusEl.textContent = '✓ Nuevo enlace copiado';
      setTimeout(() => { if (statusEl.textContent === '✓ Nuevo enlace copiado') statusEl.textContent = ''; }, 3000);
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = `Error: ${e.message}`;
  }
}

// Admin "Disconnect": forcibly kicks a guest-link viewer right now (see
// signaling.js's 'disconnectGuest' WS case).
async function disconnectGuest(peerId) {
  try {
    await request('disconnectGuest', { peerId });
  } catch (e) {
    alert(`No se pudo desconectar al invitado: ${e.message}`);
  }
}

function showAddUser() {
  document.getElementById('add-user-form').style.display = 'block';
  document.getElementById('new-username').value = '';
  document.getElementById('new-password').value = '';
  document.getElementById('new-role').value = 'viewer';
}

async function apiCall(method, path, body) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, opts);
  return res;
}

async function loadUsers() {
  const res = await apiCall('GET', '/api/users');
  if (!res.ok) return;
  const users = await res.json();
  const list = document.getElementById('user-list');
  list.innerHTML = users.map(u => `
    <div style="display:flex; align-items:center; gap:10px; padding:8px; border-bottom:1px solid #333;">
      <span style="flex:1; font-weight:bold;">${u.username}</span>
      <select onchange="changeRole(${u.id}, this.value)" style="padding:3px 6px; border-radius:4px; border:1px solid #333; background:#1a1a2e; color:#7b2ff7; font-size:12px;">
        <option value="viewer" ${u.role==='viewer'?'selected':''}>viewer</option>
        <option value="publisher" ${u.role==='publisher'?'selected':''}>publisher</option>
        <option value="admin" ${u.role==='admin'?'selected':''}>admin</option>
      </select>
      <button onclick="editPassword(${u.id}, '${u.username}')" style="background:#666; font-size:11px; padding:3px 10px;">🔑 Pass</button>
      <button onclick="deleteUser(${u.id}, '${u.username}')" style="background:#ff5252; font-size:11px; padding:3px 10px;">Delete</button>
    </div>
  `).join('');
}

async function addUser() {
  const username = document.getElementById('new-username').value.trim();
  const password = document.getElementById('new-password').value.trim();
  const role = document.getElementById('new-role').value;
  if (!username || !password) return;
  const res = await apiCall('POST', '/api/users', { username, password, role });
  if (res.ok) {
    document.getElementById('add-user-form').style.display = 'none';
    loadUsers();
  } else {
    const err = await res.json();
    alert(err.error || 'Error creating user');
  }
}

async function changeRole(id, role) {
  await apiCall('PUT', `/api/users/${id}`, { role });
  loadUsers();
}

async function editPassword(id, name) {
  const newPass = prompt(`New password for "${name}":`);
  if (!newPass) return;
  await apiCall('PUT', `/api/users/${id}`, { password: newPass });
  alert(`Password updated for "${name}"`);
}

async function deleteUser(id, name) {
  if (!confirm(`Delete user "${name}"?`)) return;
  await apiCall('DELETE', `/api/users/${id}`);
  loadUsers();
}

async function resetServer() {
  if (!confirm('Reset server? This will disconnect all streams and viewers.')) return;
  const res = await apiCall('POST', '/api/reset');
  if (res.ok) {
    alert('Server reset OK');
    disconnectStream();
  } else {
    alert('Reset failed');
  }
}

// ── Latency measurement: glass-to-glass estimation ──
let latencyTimer = null;
let lastRtt = 0;
function startLatencyMonitor() {
  if (latencyTimer) return;
  // Measure RTT + WebRTC stats every 3 seconds
  latencyTimer = setInterval(async () => {
    if (!activeStreamId) return;
    // HTTP RTT
    try {
      const t0 = performance.now();
      const res = await fetch(`${baseUrl}/health`, { cache: 'no-store' });
      if (res.ok) lastRtt = Math.round(performance.now() - t0);
    } catch {}
    // WebRTC consumer stats for glass-to-glass
    if (activeConsumer) {
      try {
        const stats = await activeConsumer.getStats();
        let g2gReal = null, jbMs = 0, decMs = 0;
        for (const r of stats.values()) {
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            // estimatedPlayoutTimestamp = NTP capture time of current frame
            if (r.estimatedPlayoutTimestamp) {
              g2gReal = Math.round(Date.now() - r.estimatedPlayoutTimestamp);
            }
            if (r.jitterBufferDelay && r.jitterBufferEmittedCount > 0)
              jbMs = (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000;
            if (r.totalDecodeTime && r.framesDecoded > 0)
              decMs = (r.totalDecodeTime / r.framesDecoded) * 1000;
          }
        }
        if (g2gReal !== null && g2gReal > 0 && g2gReal < 30000) {
          // Real glass-to-glass via NTP timestamps
          document.getElementById('latency').textContent = `⏱ g2g: ${g2gReal}ms`;
        } else {
          // Fallback: estimate
          const net = Math.round(lastRtt / 2);
          const g2g = Math.round(33 + net + jbMs + decMs + 16);
          document.getElementById('latency').textContent = `⏱ g2g≈${g2g}ms`;
        }
      } catch {}
    }
  }, 3000);
}
function stopLatencyMonitor() {
  if (latencyTimer) { clearInterval(latencyTimer); latencyTimer = null; }
  document.getElementById('latency').textContent = '';
}

// Start
// A "?s=<streamId>&k=<key>" guest link skips login entirely and locks the
// viewer to that one stream (see startGuestViewer()); anything else falls
// back to the normal username/password flow.
(function start() {
  startVuMeterLoop();
  const nameInput = document.getElementById('display-name-input');
  if (nameInput) nameInput.value = displayName;
  const params = new URLSearchParams(location.search);
  const guestStreamId = params.get('s');
  const guestKey = params.get('k');
  if (guestStreamId && guestKey) {
    startGuestViewer(guestStreamId, guestKey);
  } else {
    showLogin();
  }
})();
