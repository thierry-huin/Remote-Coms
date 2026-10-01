/**
 * HLS Output Manager
 *
 * Lets any live stream ALSO be served as HLS (.m3u8 + .ts segments), in
 * parallel to the normal low-latency WebRTC path, for playback on devices
 * that can't do WebRTC (e.g. an LG WebOS TV's browser) -- see web/hls.html.
 *
 * Architecture (see the approved plan for the full rationale): this does
 * NOT touch the publisher machine at all. The backend already holds the
 * exact same mediasoup video/audio Producer used to serve every WebRTC
 * viewer -- we just add ONE MORE Consumer of it, on a dedicated PlainTransport
 * pointed at a local UDP port, and feed that into a single gst-launch-1.0
 * process per stream:
 *   - Video: PASSTHROUGH remux only (h264parse, no decode/re-encode) --
 *     the H264 bytes are already encoded for WebRTC, so this costs
 *     essentially nothing.
 *   - Audio: Opus -> AAC transcode (voaacenc) -- unavoidable, since HLS/TV
 *     playback overwhelmingly expects AAC, not Opus. Cheap (audio-only).
 *   - hlssink2 (confirmed available in this image's gstreamer1.0-plugins-bad;
 *     hlssink3 is NOT packaged on Debian bookworm) accepts 'video' and
 *     'audio' request pads DIRECTLY and muxes to MPEG-TS internally (via its
 *     child splitmuxsink) -- no separate mpegtsmux element needed.
 *
 * The on-screen "stream name + g2g" overlay is intentionally NOT burned into
 * the video here -- see web/hls.html, which renders it as a plain HTML/CSS
 * layer instead (zero extra server transcode cost, trivially restylable).
 */

const { spawn } = require('child_process');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

const HLS_DIR = process.env.HLS_DIR || '/app/data/hls';

// streamId -> { process, videoTransport, audioTransport, videoConsumer,
//               audioConsumer, key, dir }
const sessions = new Map();

// Same "bind to port 0, read it, close it" trick used by installer/tools/
// publish.js's reserveUdpPort() -- picks a free local UDP port for
// gst-launch's udpsrc to listen on, which we then tell mediasoup's
// PlainTransport to send RTP to.
function reserveUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

// Builds the `application/x-rtp,...` caps GStreamer's udpsrc needs, straight
// from the mediasoup Consumer's own negotiated rtpParameters -- so this
// always matches whatever the router actually negotiated (H264 profile,
// payload type, etc.), never a hardcoded guess.
function rtpCapsFor(kind, rtpParameters) {
  const codec = rtpParameters.codecs[0];
  const encodingName = codec.mimeType.split('/')[1].toUpperCase();
  return `application/x-rtp,media=${kind},encoding-name=${encodingName},` +
    `payload=${codec.payloadType},clock-rate=${codec.clockRate}`;
}

/**
 * Start (or restart, if already running) HLS output for `streamId`.
 * `router` is mediasoup's Router (see mediasoup-manager.js's getRouter()),
 * `videoProducer`/`audioProducer` are that stream's CURRENT producers
 * (audioProducer may be null/undefined -- HLS still works video-only).
 * `key` is the unguessable per-stream key (see signaling.js's
 * streamHlsKeys) used to namespace the segment directory, so the URL alone
 * doesn't leak the human-readable streamId.
 */
async function startHls(streamId, router, videoProducer, audioProducer, key) {
  await stopHls(streamId); // idempotent: replace any previous session cleanly

  if (!videoProducer || videoProducer.closed) {
    throw new Error(`No video producer to serve HLS from for stream=${streamId}`);
  }

  const dir = path.join(HLS_DIR, key);
  fs.mkdirSync(dir, { recursive: true });

  const videoPort = await reserveUdpPort();
  const audioPort = (audioProducer && !audioProducer.closed) ? await reserveUdpPort() : null;

  const videoTransport = await router.createPlainTransport({
    listenInfo: { protocol: 'udp', ip: '0.0.0.0', announcedAddress: '127.0.0.1' },
    rtcpMux: true,
    comedia: false,
  });
  await videoTransport.connect({ ip: '127.0.0.1', port: videoPort });
  const videoConsumer = await videoTransport.consume({
    producerId: videoProducer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: true,
  });

  let audioTransport = null, audioConsumer = null;
  if (audioPort) {
    audioTransport = await router.createPlainTransport({
      listenInfo: { protocol: 'udp', ip: '0.0.0.0', announcedAddress: '127.0.0.1' },
      rtcpMux: true,
      comedia: false,
    });
    await audioTransport.connect({ ip: '127.0.0.1', port: audioPort });
    audioConsumer = await audioTransport.consume({
      producerId: audioProducer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
    });
  }

  const gstArgs = [
    '-e', '-v',
    'hlssink2', 'name=hlssink',
    `location=${path.join(dir, 'segment%05d.ts')}`,
    `playlist-location=${path.join(dir, 'playlist.m3u8')}`,
    // playlist-length/max-files used to be 6/8 -- with segments actually
    // landing around ~1s each (hlssink2 cuts on keyframe boundaries, so
    // real duration tracks the publisher's keyframe interval, not this
    // target-duration hint), that only kept 6-8 SECONDS of video on disk.
    // Confirmed in the field: WebOS stuck on a black frame and VLC quitting
    // immediately, both consistent with the player's first few segment
    // fetches 404ing because totally normal startup/network/TLS latency
    // (a few seconds) was enough for the manifest's oldest segments to
    // already be rotated out and deleted before the player could GET them.
    // Widening the window trades a bit more live latency (a handful of
    // extra seconds, fine for passive TV viewing) for not racing every
    // single player's startup against our own segment-deletion clock.
    'target-duration=2', 'playlist-length=12', 'max-files=20',
    'udpsrc', `port=${videoPort}`, `caps=${rtpCapsFor('video', videoConsumer.rtpParameters)}`,
    '!', 'rtpjitterbuffer', '!', 'rtph264depay', '!', 'h264parse', 'config-interval=-1',
    '!', 'hlssink.video',
  ];
  if (audioConsumer) {
    gstArgs.push(
      'udpsrc', `port=${audioPort}`, `caps=${rtpCapsFor('audio', audioConsumer.rtpParameters)}`,
      '!', 'rtpjitterbuffer', '!', 'rtpopusdepay', '!', 'opusdec',
      '!', 'audioconvert', '!', 'audioresample',
      '!', 'voaacenc', 'bitrate=128000', '!', 'aacparse',
      '!', 'hlssink.audio',
    );
  }

  const proc = spawn('gst-launch-1.0', gstArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => console.log(`[HLS:${streamId}] ${d.toString().trim()}`));
  proc.stderr.on('data', (d) => console.log(`[HLS:${streamId}] ${d.toString().trim()}`));
  proc.on('exit', (code) => {
    console.log(`[HLS:${streamId}] gst-launch exited (code=${code})`);
    if (sessions.get(streamId)?.process === proc) sessions.delete(streamId);
  });

  sessions.set(streamId, { process: proc, videoTransport, audioTransport, videoConsumer, audioConsumer, key, dir });

  // Resume only after gst-launch is spawned (udpsrc up), same margin of
  // safety already used elsewhere in this codebase (e.g. publish.js's
  // native Decklink audio branch) to avoid mediasoup pushing the first few
  // RTP packets into a socket nobody is listening on yet.
  await videoConsumer.resume();
  if (audioConsumer) await audioConsumer.resume();

  console.log(`[HLS] ${streamId}: started (video=${videoPort}${audioPort ? ` audio=${audioPort}` : ''}) -> ${dir}`);
}

/** Stop HLS output for `streamId` (no-op if not running) and remove its segment files. */
function stopHls(streamId) {
  const s = sessions.get(streamId);
  if (!s) return;
  sessions.delete(streamId);
  try { s.process.kill('SIGTERM'); } catch (_) {}
  try { s.videoConsumer?.close(); } catch (_) {}
  try { s.audioConsumer?.close(); } catch (_) {}
  try { s.videoTransport?.close(); } catch (_) {}
  try { s.audioTransport?.close(); } catch (_) {}
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (_) {}
  console.log(`[HLS] ${streamId}: stopped`);
}

function isRunning(streamId) {
  return sessions.has(streamId);
}

function stopAll() {
  for (const streamId of [...sessions.keys()]) stopHls(streamId);
}

module.exports = { startHls, stopHls, isRunning, stopAll };
