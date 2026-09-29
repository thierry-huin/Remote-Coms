#!/usr/bin/env node
/**
 * Winus Video — Node.js Publisher (video only)
 * Connects to the video server via WS, creates a PlainTransport,
 * registers the producer, then spawns GStreamer to send H.264 RTP.
 *
 * Usage:
 *   node publish.js [wss://server:9443/ws]
 *
 * Env: AUTH_TOKEN (required), BITRATE, FPS, DEINTERLACE, SOURCE, DEVICE, DEVICE_INDEX, KEYFRAME_S, STREAM_ID, STREAM_NAME
 */
const WebSocket = require('ws');
const { spawn } = require('child_process');
const dgram = require('dgram');
const path = require('path');

const SERVER = process.argv[2] || 'wss://localhost:9443/ws';
const STREAM_ID = process.env.STREAM_ID || 'stream-1';
const STREAM_NAME = process.env.STREAM_NAME || STREAM_ID;
const BITRATE = process.env.BITRATE || '4000';
const FPS = process.env.FPS || '30';
const DEINTERLACE = process.env.DEINTERLACE || '0';
const SOURCE = process.env.SOURCE || 'videotestsrc';
const DEVICE = process.env.DEVICE || '/dev/video0';
const DEVICE_INDEX = process.env.DEVICE_INDEX || '0';
const KEYFRAME_S = process.env.KEYFRAME_S || '2';
// 'nvenc' (NVIDIA hardware H.264), 'amf' (AMD hardware H.264, e.g. a Ryzen
// iGPU), or 'x264' (software, the long-standing default) -- see the GUI's
// global GPU checkbox and _windows_nvenc_available()/_windows_amf_available()
// in installer/video_publisher.py. Set per-publish by the Python GUI, which
// already verified the corresponding hardware encoder is actually usable on
// this machine before ever sending 'nvenc'/'amf' here.
const VIDEO_ENCODER = process.env.VIDEO_ENCODER || 'x264';
const AUDIO_SOURCE = process.env.AUDIO_SOURCE || 'none';
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '128000';
const AUDIO_FRAME_MS = process.env.AUDIO_FRAME_MS || '10';
const CLOCK_OVERLAY = process.env.CLOCK_OVERLAY || '0';
// Parallel HLS output (WebOS/Smart TV) toggle -- see the GUI's per-row 'HLS'
// checkbox in installer/video_publisher.py. Sent to the server as
// 'setHlsEnabled' once the video producer is registered (see main()); the
// server (mediasoup-manager.js/hls-manager.js) owns the actual GStreamer
// transcode process, nothing runs on the publisher machine for this.
const HLS_ENABLED = process.env.HLS_ENABLED || '0';
const RETURN_AUDIO_ENABLED = process.env.RETURN_AUDIO_ENABLED || '1';
// Per-kind enable flags (GUI: "\ud83d\udeab Deshabilitado" in the Retorno dialog sets these to
// '0'). Default enabled ('1') when unset, for backward compatibility with
// callers that don't set them.
const PGM_ENABLED = (process.env.PGM_ENABLED ?? '1') === '1';
const TALKBACK_ENABLED = (process.env.TALKBACK_ENABLED ?? '1') === '1';
const IS_WIN = process.platform === 'win32';
const VALID_AUDIO_FRAME_MS = new Set([10, 20, 40, 60]);
let mainAudioHandle = null;
let mainVideoHandle = null;

let requestSeq = 0;
const pending = new Map();
const messageListeners = []; // for unsolicited (no requestId) push messages, e.g. returnProducerChanged

/**
 * Exit the process only after pending stdout/stderr writes have flushed.
 *
 * On Windows, writes to piped stdio are ASYNCHRONOUS. Calling process.exit()
 * immediately after console.log()/console.error() can terminate the process
 * before that write reaches the parent pipe, silently dropping the message
 * (this is documented Node.js behavior). That was the actual reason the
 * publisher GUI showed "CH1: exited (rc=1)" with zero explanation: whatever
 * was logged right before the exit() call never made it out. Route every
 * intentional-exit path (and any previously-uncaught error) through here so
 * the real cause is always visible in the GUI log going forward.
 */
function safeExit(code, finalLine) {
  if (finalLine) {
    if (code === 0) console.log(finalLine); else console.error(finalLine);
  }
  let remaining = 2;
  const proceed = () => { if (--remaining <= 0) process.exit(code); };
  process.stdout.write('', proceed);
  process.stderr.write('', proceed);
  // Safety net in case a stream never drains (e.g. broken pipe) — don't hang forever.
  setTimeout(() => process.exit(code), 3000).unref();
}

process.on('uncaughtException', (err) => {
  safeExit(1, `\u2716 Fatal (uncaughtException): ${err && err.stack || err}`);
});
process.on('unhandledRejection', (err) => {
  safeExit(1, `\u2716 Fatal (unhandledRejection): ${err && err.stack || err}`);
});

function request(ws, type, data = {}) {
  const requestId = ++requestSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${type} timeout`)); }, 10000);
    pending.set(requestId, { resolve: (msg) => { clearTimeout(timer); resolve(msg); }, reject });
    ws.send(JSON.stringify({ type, requestId, ...data }));
  });
}

function onPush(type, handler) {
  messageListeners.push((msg) => { if (msg.type === type) handler(msg); });
}

function reserveUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, '0.0.0.0', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

function waitForExit(child, timeoutMs = 1500) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once('exit', finish);
    setTimeout(finish, timeoutMs);
  });
}

/**
 * Main outgoing audio (publisher -> viewers), deliberately owned directly
 * by this Node process on EVERY OS. Keeping it outside the video GStreamer
 * process lets the GUI change Opus frame duration live: only this audio
 * encoder is killed/restarted, while video and the mediasoup audio Producer
 * stay untouched.
 *
 * mediasoup's PlainTransport uses comedia=true and locks to the sender's
 * source tuple after the first packet. Therefore every respawn MUST reuse
 * the same local RTP source port (ffmpeg localrtpport / udpsink bind-port),
 * otherwise mediasoup would silently ignore the replacement encoder.
 */
async function startAudioEncoder(destIp, audioPort, {
  source, device, channels, bitrate, frameMs,
}) {
  const localRtpPort = await reserveUdpPort();
  let currentFrameMs = Number(frameMs);
  let children = [];
  let operation = Promise.resolve();
  let stopped = false;

  const killChildren = async (signal = 'SIGTERM') => {
    const old = children;
    children = [];
    for (const child of old) {
      try { child.kill(signal); } catch (_) {}
    }
    await Promise.all(old.map((child) => waitForExit(child)));
  };

  const spawnEncoder = () => {
    if (stopped) return;
    const rtpUrl = `rtp://${destIp}:${audioPort}?localrtpport=${localRtpPort}`;
    const numCh = Math.max(1, (channels || '1-2').split(/[-,]/).filter(Boolean).length);
    const bitrateKbps = Math.round(parseInt(bitrate, 10) / 1000) || 128;

    // Real, explicitly-selected devices (plus Linux's "auto" default) use
    // sounddevice -> ffmpeg, preserving the wall-clock drift correction.
    if (source === 'sounddevice' || source === 'auto') {
      const pythonBin = IS_WIN ? 'python' : 'python3';
      const capture = spawn(pythonBin, [
        path.join(__dirname, 'audio_capture.py'),
        `--device=${device || ''}`, `--channels=${channels || '1-2'}`,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      capture.stderr.on('data', (d) => process.stderr.write(`[audio_capture] ${d}`));

      // -use_wallclock_as_timestamps + aresample correct hardware-clock
      // drift against real time (see the detailed explanation in the
      // previous fixed implementation). frame_duration is the value exposed
      // by the publisher's live "Buf" control.
      //
      // IMPORTANT: do NOT set aresample's first_pts=0 here. With
      // -use_wallclock_as_timestamps the very first input pts is an
      // absolute wall-clock value (epoch-scale, e.g. ~1.7e9), not a
      // small/relative one. Forcing first_pts=0 makes aresample treat that
      // entire epoch offset as drift-to-correct on every single buffer,
      // which always exceeds min_hard_comp and therefore NEVER succeeds
      // ("Failed to compensate for timestamp delta of <epoch-ish number>"
      // logged forever), starving/breaking the outgoing audio. Leaving
      // first_pts unset makes aresample use that first real wall-clock
      // pts as its own baseline, so only genuine (small) subsequent drift
      // gets compensated.
      //
      // IMPORTANT: async=1 here, NOT a large value like 1000. A large async
      // lets aresample continuously stretch/compress (resample) audio by up
      // to that many samples/sec to chase every tiny bit of wallclock
      // jitter -- confirmed on real hardware to sound like a constant,
      // audible "elastic"/pitch-wobble artifact on tonal content (music);
      // masked on speech, which tolerates small pitch variation far better,
      // so it went unnoticed until music was monitored. async=1 disables
      // that continuous rate adjustment entirely and instead only pads/trims
      // (inserts or drops) samples, and only once actual drift exceeds
      // min_hard_comp below -- i.e. rare, discrete corrections instead of a
      // permanent pitch-shift, while still preventing unbounded long-term
      // A/V drift from a genuine hardware clock mismatch.
      //
      // The trailing asetpts=N/SR/TB is required too: aresample's drift
      // correction re-labels its *output* frames using pts still derived
      // from the jittery wallclock input, which can occasionally go
      // slightly backward between consecutive buffers. libopus refuses that
      // ("Queue input is backward in time" / "Non-monotonic DTS"), which
      // corrupts/mutes the encoded stream. asetpts re-derives a clean,
      // strictly-increasing pts from the actual output sample count (N/SR),
      // which is exactly what an encoder wants, while leaving aresample's
      // actual drift correction untouched.
      const ffmpegAudio = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'warning',
        '-fflags', 'nobuffer', '-flags', 'low_delay',
        '-f', 'f32le', '-ar', '48000', '-ac', String(numCh),
        '-use_wallclock_as_timestamps', '1', '-i', 'pipe:0',
        '-af', 'aresample=async=1:min_hard_comp=0.100,asetpts=N/SR/TB',
        '-ac', '2', '-c:a', 'libopus', '-b:a', `${bitrateKbps}k`,
        '-application', 'lowdelay', '-frame_duration', String(currentFrameMs),
        '-ssrc', '2222', '-payload_type', '100',
        '-f', 'rtp', rtpUrl,
      ], { stdio: ['pipe', 'ignore', 'pipe'] });
      capture.stdout.pipe(ffmpegAudio.stdin);
      ffmpegAudio.stderr.on('data', (d) => process.stderr.write(`[ffmpeg-audio] ${d}`));
      capture.on('exit', (code) => {
        if (!stopped && children.includes(capture)) console.log(`\u25b8 audio_capture.py exited (code=${code})`);
      });
      children = [capture, ffmpegAudio];
      console.log(`\u25b8 Audio: sounddevice(${device || 'default'}) ch=${channels} ` +
        `buffer=${currentFrameMs}ms localRtp=${localRtpPort} -> ${rtpUrl}`);
      return;
    }

    // Native GStreamer sources (test tone, WASAPI loopback/default,
    // osxaudiosrc, etc.). These already run from a live pipeline clock, so
    // they do not need ffmpeg's wall-clock drift correction.
    const gstBin = IS_WIN ? 'gst-launch-1.0.exe' : 'gst-launch-1.0';
    const sourceArgs = source === 'audiotestsrc'
      ? ['audiotestsrc', 'is-live=true', 'wave=sine', 'freq=440']
      : String(source).split(/\s+/).filter(Boolean);
    const gstAudio = spawn(gstBin, [
      '-v', ...sourceArgs,
      '!', 'audioconvert', '!', 'audioresample',
      '!', 'audio/x-raw,rate=48000,channels=2',
      '!', 'opusenc', `bitrate=${bitrate}`, `frame-size=${currentFrameMs}`,
      '!', 'rtpopuspay', 'pt=100', 'ssrc=2222',
      '!', 'udpsink', `host=${destIp}`, `port=${audioPort}`,
      `bind-port=${localRtpPort}`, 'sync=false',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    gstAudio.stdout.on('data', (d) => process.stdout.write(d));
    gstAudio.stderr.on('data', (d) => process.stderr.write(d));
    children = [gstAudio];
    console.log(`\u25b8 Audio: ${source} buffer=${currentFrameMs}ms ` +
      `localRtp=${localRtpPort} -> rtp://${destIp}:${audioPort}`);
  };

  spawnEncoder();
  return {
    restart(newFrameMs) {
      const value = Number(newFrameMs);
      if (!VALID_AUDIO_FRAME_MS.has(value)) {
        return Promise.reject(new Error(`Invalid audio buffer: ${newFrameMs}ms`));
      }
      operation = operation.then(async () => {
        if (stopped || value === currentFrameMs) return;
        await killChildren();
        currentFrameMs = value;
        spawnEncoder();
      });
      return operation;
    },
    kill(signal = 'SIGTERM') {
      stopped = true;
      operation = operation.then(() => killChildren(signal));
      return operation;
    },
  };
}

/**
 * Video encoder (GStreamer), independently killable/restartable so the GUI's
 * live clock-overlay toggle (the button next to On Air) can relaunch just the
 * video pipeline without disturbing mediasoup's comedia-locked video
 * PlainTransport -- same fixed-local-port reasoning as startAudioEncoder()
 * above. A restart is visibly more disruptive than the audio one (a couple
 * of video frames are lost while x264enc/vtenc_h264 re-initializes and sends
 * a fresh keyframe), which is expected.
 *
 * Because this replaces the single "gst.on('exit', ...)" that used to end
 * the whole publish.js process the instant video died, a plain kill/respawn
 * from restart() must NOT be mistaken for a real crash. setFatalExitHandler()
 * lets main() attach its "tear everything down" handler AFTER all the other
 * pieces (audio encoder, producers, return audio, keepalive) exist, exactly
 * where the old inline gst.on('exit', ...) used to live -- if video happens
 * to crash before that handler is attached, the exit is remembered and
 * replayed the moment a handler finally is.
 */
// Map ffmpeg's (lowercase) pixel format names to GStreamer's rawvideoparse
// format enum names, for the macOS ffmpeg_avfoundation video path below.
// Covers the formats actually observed on real AVFoundation devices/OBS
// Virtual Camera; falls back to an uppercase guess for anything else.
const FFMPEG_TO_GST_FORMAT = {
  nv12: 'NV12',
  uyvy422: 'UYVY',
  yuyv422: 'YUY2',
  yuv420p: 'I420',
  '0rgb': 'xRGB',
  bgr0: 'BGRx',
};

async function startVideoEncoder(destIp, videoPort, { clockOverlay, audioPort }) {
  const localRtpPort = await reserveUdpPort();
  // Native Blackmagic Decklink embedded audio (AUDIO_SOURCE='decklink_native:<persistent-id>',
  // see detect_audio_sources() in installer/video_publisher.py) MUST be
  // captured by a decklinkaudiosrc element in THIS SAME gst-launch process,
  // never as an independent process (see startAudioEncoder, which is
  // skipped entirely by main() for this AUDIO_SOURCE value): confirmed on
  // real hardware that Blackmagic's SDK does not allow two separate
  // processes to each open their own native capture session on the same
  // physical connector at once -- a second one (even audio-only, via a
  // separate decklinkaudiosrc pipeline) errors out immediately, and the
  // alternative (capturing that connector's audio via the Windows-level WDM
  // "Line In" device while decklinkvideosrc holds it open for video)
  // silently returns starved/near-silent audio instead of erroring.
  const audioPersistentId = AUDIO_SOURCE.startsWith('decklink_native:') ? AUDIO_SOURCE.split(':')[1] : null;
  const audioLocalRtpPort = audioPersistentId ? await reserveUdpPort() : null;
  let currentClock = !!clockOverlay;
  let children = [];
  let operation = Promise.resolve();
  let stopped = false;
  let expectedExit = false;
  let fatalHandler = null;
  let pendingFatal = null;

  const killChildren = async (signal = 'SIGTERM') => {
    const old = children;
    children = [];
    for (const c of old) {
      try { c.kill(signal); } catch (_) {}
    }
    await Promise.all(old.map((c) => waitForExit(c)));
  };

  // Any tracked child exiting unexpectedly is fatal for this encoder --
  // whichever process it is, the RTP flow stops. `handled` guards against a
  // paired process's near-simultaneous exit (e.g. killing ffmpeg makes
  // gst-launch's fdsrc hit EOF a moment later) double-firing this.
  let handled = false;
  const onChildExit = (code, signal) => {
    if (stopped || expectedExit || handled) return;
    handled = true;
    if (fatalHandler) fatalHandler(code, signal);
    else pendingFatal = { code, signal };
  };

  const spawnVideo = () => {
    if (stopped) return;
    handled = false;
    if (!IS_WIN && SOURCE === 'ffmpeg_avfoundation') {
      // macOS cameras: avfvideosrc's device-index is not stable across runs
      // (see detect_video_sources() in installer/video_publisher.py), so the
      // device is captured by ffmpeg selecting it by its exact NAME, piping
      // raw video into gst-launch-1.0 for encoding/RTP -- same
      // capture-process -> ffmpeg-process pairing pattern as
      // startAudioEncoder()'s sounddevice/ffmpeg pipe above.
      const deviceName = process.env.DEVICE_NAME || '';
      const videoSize = process.env.VIDEO_SIZE || '1280x720';
      const [w, h] = videoSize.split('x');
      const framerate = process.env.VIDEO_FRAMERATE || '30';
      const pixelFormat = process.env.VIDEO_PIXEL_FORMAT || 'uyvy422';
      const gstFormat = FFMPEG_TO_GST_FORMAT[pixelFormat] || pixelFormat.toUpperCase();
      const keyInt = parseInt(FPS, 10) * parseInt(KEYFRAME_S, 10);

      // NOTE: AVFoundation reports a bogus "1000k" (1,000,000) tbr/tbn for
      // some virtual cameras (confirmed on "OBS Virtual Camera"), regardless
      // of the requested -framerate above, which only selects the capture
      // mode. Without an explicit OUTPUT -r, ffmpeg inherits that bogus
      // value as its target output rate and its cfr/vsync logic tries to
      // reach ~1,000,000 fps by duplicating the last real frame hundreds of
      // thousands of times per second -- the video appears frozen on the
      // first real frame forever (audio, a separate pipeline, is unaffected).
      // Forcing -r here makes ffmpeg pace/duplicate against the real target
      // rate instead.
      const ffmpegVideo = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'warning',
        '-f', 'avfoundation', '-pixel_format', pixelFormat,
        '-framerate', framerate, '-video_size', videoSize,
        '-i', `${deviceName}:none`,
        '-r', framerate,
        '-f', 'rawvideo', '-pix_fmt', pixelFormat, '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      ffmpegVideo.stderr.on('data', (d) => process.stderr.write(`[ffmpeg-video] ${d}`));

      const gstArgs = ['-v', 'fdsrc', 'fd=0', '!',
        'rawvideoparse', `format=${gstFormat}`, `width=${w}`, `height=${h}`, `framerate=${framerate}/1`,
        '!', 'videoconvert'];
      if (DEINTERLACE === '1') gstArgs.push('!', 'deinterlace', 'method=linear');
      if (currentClock) {
        gstArgs.push('!', 'clockoverlay', 'halignment=left', 'valignment=top',
          'font-desc=Monospace,9', 'shaded-background=true', 'time-format=%H:%M:%S');
      }
      gstArgs.push(
        '!', 'vtenc_h264', `bitrate=${BITRATE}`, 'realtime=true',
        'allow-frame-reordering=false', `max-keyframe-interval=${keyInt}`,
        '!', 'h264parse',
        '!', 'rtph264pay', 'pt=101', 'config-interval=-1', 'ssrc=1111',
        '!', 'udpsink', `host=${destIp}`, `port=${videoPort}`, `bind-port=${localRtpPort}`, 'sync=false',
      );
      const gstVideo = spawn('gst-launch-1.0', gstArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      ffmpegVideo.stdout.pipe(gstVideo.stdin);
      gstVideo.stdout.on('data', (d) => process.stdout.write(d));
      gstVideo.stderr.on('data', (d) => process.stderr.write(d));
      ffmpegVideo.on('exit', onChildExit);
      gstVideo.on('exit', onChildExit);
      children = [ffmpegVideo, gstVideo];
      console.log(`\u25b8 Video: ffmpeg avfoundation "${deviceName}" ${videoSize}@${framerate} (${pixelFormat}) ` +
        `-> gst-launch (PID ${gstVideo.pid}) clock=${currentClock ? 'on' : 'off'} localRtp=${localRtpPort}`);
      return;
    }

    let vchild;
    if (IS_WIN) {
      const keyInt = parseInt(FPS) * parseInt(KEYFRAME_S);
      // Built as an ARRAY of argv tokens per source (never a single template
      // string later split on whitespace) -- a device NAME/PATH can itself
      // contain spaces (e.g. "OBS Virtual Camera"), and splitting on
      // whitespace after embedding it in a quoted string breaks it into
      // multiple, invalid argv tokens for gst-launch-1.0.exe. Quotes are
      // still embedded around name/path VALUES (as part of a single argv
      // token) because gst-launch-1.0 rejoins its own argv into one pipeline
      // description string before parsing it, and only its own "..." quoting
      // (not OS/shell quoting) tells that parser a value contains a space.
      let srcArgs;
      switch (SOURCE) {
        case 'videotestsrc':
          srcArgs = ['videotestsrc', 'is-live=true', 'pattern=ball'];
          break;
        case 'mfvideosrc': {
          // Prefer device-path (Media Foundation's own stable identifier,
          // from detect_video_sources()'s gst-device-monitor-1.0.exe
          // probing) over device-index -- DirectShow and Media Foundation
          // enumerate devices independently, so index N in one has no
          // guaranteed relationship to index N in the other (confirmed:
          // DirectShow's 11th device had no corresponding MF device at
          // all, so device-index failed to start).
          const devicePath = process.env.DEVICE_PATH || '';
          // gst-launch-1.0's OWN pipeline-description parser treats \ as an
          // escape character inside "..."-quoted property values (confirmed
          // by gst-device-monitor-1.0.exe's own suggested command line,
          // which double-escapes backslashes in Media Foundation device
          // paths, e.g. "@device:sw:{...}\\{...}"). An unescaped single
          // backslash here gets silently swallowed by that parser,
          // corrupting the path and making mfvideosrc fail to find the
          // device ("Failed to start" / pipeline doesn't want to preroll).
          const escapedDevicePath = devicePath.replace(/\\/g, '\\\\');
          srcArgs = devicePath
            ? ['mfvideosrc', `device-path="${escapedDevicePath}"`]
            : ['mfvideosrc', `device-index=${DEVICE_INDEX}`];
          srcArgs.push('!', 'videoconvert', '!', 'videoscale', '!', 'video/x-raw,width=1920,height=1080');
          break;
        }
        case 'ksvideosrc':
          srcArgs = ['ksvideosrc', `device-index=${DEVICE_INDEX}`];
          break;
        case 'dshowvideosrc': {
          const dn = process.env.DEVICE_NAME || 'OBS Virtual Camera';
          srcArgs = ['dshowvideosrc', `device-name="${dn}"`];
          if (process.env.VIDEO_NEEDS_JPEGDEC === '1') srcArgs.push('!', 'jpegdec');
          srcArgs.push('!', 'videoconvert', '!', 'videoscale');
          break;
        }
        case 'decklinkvideosrc': {
          // Prefer persistent-id (GStreamer's own stable per-connector ID,
          // see detect_video_sources()'s Windows Decklink detection) over
          // device-number: device-number is a small per-card local index
          // (0-3 on a 4-connector card) that's reused identically by EVERY
          // card of the same model plugged into the same machine, so with
          // more than one identical card it doesn't reliably address the
          // intended physical connector (confirmed on real hardware with
          // two Duo 2 Mini cards -- device-number captured the wrong/no
          // signal instead of the expected feed). Falls back to
          // device-number only for older detections that never set
          // PERSISTENT_ID (single-card setups, or an older GStreamer build
          // without the persistent-id device property).
          const persistentId = process.env.PERSISTENT_ID || '';
          const deckSrcArgs = persistentId
            ? ['decklinkvideosrc', `persistent-id=${persistentId}`]
            : ['decklinkvideosrc', `device-number=${DEVICE_INDEX}`];
          // A 'videoconvert' MUST run BEFORE 'deinterlace', not after: Decklink
          // hardware outputs raw v210 (10-bit packed), which the 'deinterlace'
          // element does NOT support (it only handles I420/YUY2/UYVY/NV12/etc)
          // -- confirmed on real hardware feeding an actually-interlaced signal
          // (1080i25/PAL): with v210 straight into deinterlace, it silently
          // passed the buffers through UNCHANGED (still interlace-mode=
          // interleaved) instead of deinterlacing or erroring, which then made
          // x264enc negotiate a profile incompatible with the pipeline's
          // hardcoded profile capsfilter (interlaced coding isn't allowed
          // under every profile), killing the whole pipeline with
          // "not-negotiated". A progressive source (e.g. 1080p60) never
          // exposed this, since deinterlace passing it through unchanged is
          // a harmless no-op either way. The second, later 'videoconvert' (added for every
          // Windows source right after this switch) still runs too, ahead of
          // videoscale/x264enc, and is a cheap no-op once already converted.
          srcArgs = [...deckSrcArgs, 'mode=auto', 'connection=auto',
            '!', 'videoconvert', '!', 'deinterlace', '!', 'videoconvert', '!', 'videoscale', '!', 'video/x-raw,width=1920,height=1080'];
          break;
        }
        case 'd3d11screencapturesrc':
          srcArgs = ['d3d11screencapturesrc', `monitor-index=${process.env.MONITOR_INDEX || '0'}`, 'show-cursor=true'];
          break;
        default:
          srcArgs = String(SOURCE).split(/\s+/).filter(Boolean);
          break;
      }
      const gstArgs = ['-v', ...srcArgs];
      if (DEINTERLACE === '1') gstArgs.push('!', 'deinterlace', 'method=linear');
      gstArgs.push('!', 'videoconvert');
      if (currentClock) {
        gstArgs.push('!', 'clockoverlay', 'halignment=left', 'valignment=top',
          'font-desc=Monospace,9', 'shaded-background=true', 'time-format=%H:%M:%S');
      }
      // GPU (NVENC) vs software (x264) H.264 encoding. nvh264enc's own
      // property names/units deliberately mirror x264enc's here wherever
      // possible (bitrate in kbit/s, gop-size == key-int-max) so BITRATE/
      // keyInt keep meaning the same thing regardless of encoder. preset=p1
      // (fastest) + zerolatency=true + rc-mode=cbr are NVENC's closest
      // equivalents to x264enc's speed-preset=ultrafast + tune=zerolatency
      // -- confirmed on real hardware (RTX A1000) encoding 1080p far faster
      // than realtime with negligible CPU use, unlike x264enc which is
      // otherwise the single biggest CPU consumer in this app (relevant
      // with several channels publishing at once). 'high' profile (CABAC +
      // more reference frames than 'baseline') is supported by both
      // encoders' src caps and gives noticeably better quality/bitrate --
      // decode is by-hardware on virtually every modern browser, so this
      // trades a small (usually free) decode cost for real quality gains.
      // Matches mediasoup's 'High 5.0' registered codec (profile-level-id
      // 640032, see backend/src/mediasoup-config.js -- added for AMF, now
      // reused here too), so the downstream CapsFilter stays identical
      // across encoders either way.
      if (VIDEO_ENCODER === 'nvenc') {
        gstArgs.push(
          '!', 'nvh264enc', `bitrate=${BITRATE}`, 'preset=p1', 'rc-mode=cbr', 'zerolatency=true', `gop-size=${keyInt}`,
          '!', 'video/x-h264,profile=high',
          '!', 'h264parse',
          '!', 'rtph264pay', 'pt=101', 'config-interval=-1', 'ssrc=1111',
          '!', 'udpsink', `host=${destIp}`, `port=${videoPort}`, `bind-port=${localRtpPort}`, 'sync=false',
        );
      } else if (VIDEO_ENCODER === 'amf') {
        // AMD AMF hardware H.264 (amfh264enc, gst-plugins-bad's amfcodec
        // plugin, requires GStreamer 1.22+) -- the AMD equivalent of the
        // nvh264enc branch above, for machines with an AMD GPU/APU (e.g. a
        // Ryzen iGPU) instead of an NVIDIA one. See _windows_amf_available()
        // in installer/video_publisher.py for the availability probe.
        // usage=transcoding + rate-control=cbr (see the root-cause comment
        // below for why NOT 'ultra-low-latency' despite the name) is AMF's
        // closest equivalent to nvh264enc's zerolatency=true + rc-mode=cbr
        // above, verified to add no B-frame reordering/latency of its own.
        // amfh264enc's sink pad only accepts NV12 (not x264enc/nvh264enc's
        // I420) -- no explicit capsfilter is needed for that though: the
        // preceding 'videoconvert' auto-negotiates to whatever format the
        // downstream element's sink caps require, exactly like it already
        // does for x264enc/nvh264enc's own preferred format.
        // ROOT CAUSE FOUND (verified directly on real hardware via SSH:
        // captured amfh264enc's raw output to a file and fully decoded the
        // SPS with a real Exp-Golomb bitstream parser, plus counted actual
        // IDR NALs across a multi-second capture -- not just eyeballing
        // GStreamer's caps-string summary like the earlier profile
        // investigation below). Two separate things were tried and ruled
        // out/fixed:
        // 1) profile=high (kept, and IS correct/required): amfh264enc has no
        //    GObject 'profile' property, only the downstream capsfilter
        //    caps. 'baseline' silently never changed profile_idc at all;
        //    'main' did, but paired it with constraint_set5_flag=1, which
        //    Annex A only permits for profile_idc 44/100/110/122/244 (the
        //    'High' family) -- 'high' is the only one of the three where
        //    that bit is spec-legal. HOWEVER: a full Exp-Golomb parse of the
        //    actual SPS bytes confirmed this SPS was ALREADY 100% spec-
        //    conformant -- profile, level, chroma format, cropping (exact
        //    1920x1080), everything checked out. The invalid-SPS theory was
        //    wrong; it was never why the video stayed black.
        // 2) THE REAL BUG: usage=ultra-low-latency makes amfh264enc silently
        //    ignore 'gop-size' -- a direct capture+NAL-count on real
        //    hardware showed only 2 IDR frames across ~327 encoded frames
        //    (both coincident with encoder re-inits from a caps change, not
        //    from gop-size's periodic interval at all). This app never
        //    calls mediasoup's consumer.requestKeyFrame() (no RTCP PLI is
        //    forwarded to a PlainTransport-fed GStreamer producer), so a
        //    viewer who misses that one-time IDR never sees video again --
        //    exactly the "appears after minutes, black again on refresh"
        //    symptom observed live. Switching usage=transcoding made the
        //    SAME capture produce 23 IDRs in the same window, precisely
        //    matching gop-size's requested interval. Also re-verified NO
        //    B-frames appear (every slice NAL's nal_ref_idc is non-zero --
        //    all I/P, no reordering), so this doesn't reintroduce the
        //    latency 'ultra-low-latency' was meant to avoid.
        // 'high' profile matches mediasoup's registered 'High 5.0' codec
        // (profile-level-id 640032, see backend/src/mediasoup-config.js).
        gstArgs.push(
          '!', 'amfh264enc', `bitrate=${BITRATE}`, 'usage=transcoding', 'rate-control=cbr',
          `gop-size=${keyInt}`,
          '!', 'video/x-h264,profile=high',
          '!', 'h264parse',
          '!', 'rtph264pay', 'pt=101', 'config-interval=-1', 'ssrc=1111',
          '!', 'udpsink', `host=${destIp}`, `port=${videoPort}`, `bind-port=${localRtpPort}`, 'sync=false',
        );
      } else {
        gstArgs.push(
          '!', 'x264enc', `bitrate=${BITRATE}`, 'speed-preset=ultrafast', 'tune=zerolatency',
          `key-int-max=${keyInt}`, 'bframes=0',
          '!', 'video/x-h264,profile=high',
          '!', 'h264parse',
          '!', 'rtph264pay', 'pt=101', 'config-interval=-1', 'ssrc=1111',
          '!', 'udpsink', `host=${destIp}`, `port=${videoPort}`, `bind-port=${localRtpPort}`, 'sync=false',
        );
      }
      // Embedded Decklink audio branch: a SECOND top-level source-to-sink
      // chain in the SAME gst-launch pipeline description (gst-launch
      // supports multiple independent branches in one process, confirmed
      // working on real hardware -- decklinkvideosrc and decklinkaudiosrc
      // sharing one persistent-id negotiate and start cleanly together in a
      // single process, unlike as two separate processes). audioPort is
      // guaranteed set whenever audioPersistentId is (see main()).
      //
      // 'queue' right after decklinkaudiosrc (reported symptom: audio sounds
      // "compressed" with occasional freezes, video fine, SAME physical
      // signal clean in vMix -- pointing at capture, not encode/network):
      // decklinkaudiosrc's push callback runs on Blackmagic's own real-time
      // driver thread, and WITHOUT a queue that thread is also the one doing
      // audioconvert/audioresample/opusenc/rtpopuspay/udpsink (GStreamer
      // push-mode runs a whole branch on the upstream element's thread until
      // something decouples it). Any brief stall downstream -- CPU
      // contention from the video encoder in this SAME process, opusenc's
      // own encode time, a scheduling hiccup -- blocks that real-time
      // callback; the Blackmagic SDK's response to a blocked callback is to
      // drop samples internally to catch up, which surfaces exactly as
      // "compressed"-sounding audio (discontinuities getting concealed/
      // re-clocked downstream) with occasional freezes. vMix doesn't hit
      // this because it captures on its own dedicated thread with proper
      // ring-buffering, decoupled from its video/encode pipeline -- this
      // queue gives decklinkaudiosrc the same decoupling: its thread now
      // just pushes into the queue and returns immediately, and a SEPARATE
      // thread drains it into audioconvert onward. leaky=downstream bounds
      // queued latency (drops the OLDEST buffered audio instead of ever
      // blocking the capture thread again) if downstream ever falls behind
      // for longer than max-size-time.
      if (audioPersistentId && audioPort) {
        gstArgs.push(
          // alignment-threshold=0 (default is 40ms, paired with a 1s
          // discont-wait) -- ROOT CAUSE of the periodic "strong
          // compression"/click heard roughly once per second (reported live
          // on real hardware, still present after adding the queue above,
          // which ruled out a downstream-thread-blocking cause). Read
          // directly from gst-plugins-bad's gstdecklinkaudiosrc.cpp
          // create(): every buffer's timestamp comes from decklinkvideosrc's
          // continuously-recalibrated hardware->pipeline clock mapping, but
          // decklinkaudiosrc ALSO tracks its own "expected" timestamp via
          // pure sample counting; whenever those two disagree by more than
          // alignment-threshold for longer than discont-wait, it does a HARD
          // resync: sets GST_BUFFER_FLAG_DISCONT and snaps next_offset to
          // the new mapped value in one step. On this hardware that
          // disagreement apparently crosses the 40ms default almost every
          // cycle, so a correction snap fires ~every discont-wait (1s) --
          // matching the reported periodicity exactly. Setting
          // alignment-threshold=0 takes a DIFFERENT code path in that same
          // function ("else if (self->alignment_threshold == 0) { // Don't
          // align, just pass through timestamps }") that disables the
          // discont/resync logic entirely (only the very first buffer is
          // ever marked discont): buffers then keep their naturally
          // calibrated timestamps continuously, with no artificial snap
          // ever inserted. Tradeoff: this audio timestamp can now drift
          // slowly/smoothly relative to decklinkvideosrc's mapped clock
          // instead of being hard-corrected back -- imperceptible compared
          // to the audible glitch it replaces, and irrelevant to A/V sync
          // here since mediasoup/the browser's own RTCP-based sync doesn't
          // depend on this internal GStreamer buffer timestamp.
          'decklinkaudiosrc', `persistent-id=${audioPersistentId}`, 'connection=auto', 'alignment-threshold=0',
          '!', 'queue', 'leaky=downstream', 'max-size-buffers=0', 'max-size-bytes=0', 'max-size-time=1000000000',
          // 'audiorate' right after the queue: alignment-threshold=0 above
          // fixed the periodic hard-snap click, but removing that hard
          // correction means any genuine (small) clock-rate mismatch
          // between the Decklink audio hardware clock and the nominal
          // 48000 Hz declared in caps is no longer corrected AT ALL --
          // reported live as the audio "changing speed"/wobbling smoothly,
          // consistent with mediasoup/the browser's jitter buffer
          // continuously stretching/compressing playout to keep up with a
          // steadily drifting RTP timestamp base. 'audiorate' is the
          // standard GStreamer element for exactly this: it keeps the
          // stream locked to the caps' declared rate by inserting/dropping
          // samples as needed based on buffer PTS vs. expected sample count.
          //
          // tolerance=2000000000 (2s; default is 40ms, same as
          // decklinkaudiosrc's own default alignment-threshold above):
          // the real audio DATA coming out of decklinkaudiosrc with
          // alignment-threshold=0 is already fully continuous (no samples
          // are actually missing -- that setting only stopped it from
          // FORCIBLY re-snapping its declared PTS, it never drops real
          // audio in normal operation). With the default 40ms tolerance,
          // audiorate was reacting to ordinary PTS jitter from
          // decklinkvideosrc's continuously-recalibrated clock mapping as
          // if it were real gaps, and "fixing" them by inserting silence --
          // MORE often than the old once-per-second hard snap (reported
          // live as more frequent, smaller stutters/"tartamudeo" instead of
          // the previous 1s-spaced clicks). Raising tolerance well above
          // that normal per-buffer jitter (and above the queue's own 1s
          // max-size-time) makes audiorate act only as a safety net for a
          // genuinely large discontinuity (e.g. the queue actually leaking
          // under sustained backpressure, or a real driver hiccup), while
          // leaving harmless small timestamp jitter alone -- no artificial
          // silence insertion for audio that was never actually missing.
          '!', 'audiorate', 'tolerance=2000000000',
          '!', 'audioconvert', '!', 'audioresample',
          '!', 'audio/x-raw,rate=48000,channels=2',
          '!', 'opusenc', `bitrate=${AUDIO_BITRATE}`, `frame-size=${AUDIO_FRAME_MS}`,
          '!', 'rtpopuspay', 'pt=100', 'ssrc=2222',
          '!', 'udpsink', `host=${destIp}`, `port=${audioPort}`, `bind-port=${audioLocalRtpPort}`, 'sync=false',
        );
      }
      vchild = spawn('gst-launch-1.0.exe', gstArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      const gstScript = path.join(__dirname, 'gstreamer-publish.sh');
      vchild = spawn('bash', [gstScript, destIp, String(videoPort), String(localRtpPort)], {
        env: {
          ...process.env, BITRATE, FPS, DEINTERLACE, SOURCE, DEVICE, DEVICE_INDEX, KEYFRAME_S,
          CLOCK_OVERLAY: currentClock ? '1' : '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    vchild.stdout.on('data', (d) => process.stdout.write(d));
    vchild.stderr.on('data', (d) => process.stderr.write(d));
    console.log(`\u25b8 GStreamer (video) started (PID ${vchild.pid}) encoder=${IS_WIN ? VIDEO_ENCODER : 'platform-native'} ` +
      `clock=${currentClock ? 'on' : 'off'} localRtp=${localRtpPort}` +
      (audioPersistentId && audioPort ? ` + embedded Decklink audio (persistent-id=${audioPersistentId}) localRtp=${audioLocalRtpPort}` : ''));
    vchild.on('exit', onChildExit);
    children = [vchild];
  };

  spawnVideo();
  return {
    restart(newClockOverlay) {
      const value = !!newClockOverlay;
      operation = operation.then(async () => {
        if (stopped || value === currentClock) return;
        expectedExit = true;
        await killChildren();
        expectedExit = false;
        currentClock = value;
        spawnVideo();
      });
      return operation;
    },
    kill(signal = 'SIGTERM') {
      stopped = true;
      expectedExit = true;
      operation = operation.then(() => killChildren(signal));
      return operation;
    },
    setFatalExitHandler(cb) {
      fatalHandler = cb;
      if (pendingFatal) {
        const p = pendingFatal;
        pendingFatal = null;
        cb(p.code, p.signal);
      }
    },
  };
}

/**
 * Reads one-JSON-object-per-line commands from OUR OWN stdin, sent by the GUI
 * (installer/video_publisher.py) while this process is already running --
 * currently just the "On Air" toggle (see its On Air button, right next to
 * Play/Stop). Mirrors the IPC style already used between this process and
 * return-audio-receiver.py, just in the other direction (parent -> child).
 */
function listenForGuiCommands(ws) {
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let cmd;
      try { cmd = JSON.parse(line); } catch { continue; }
      handleGuiCommand(ws, cmd).catch((err) =>
        console.log(`\u25b8 GUI command error (${cmd?.cmd}): ${err.message}`));
    }
  });
}

async function handleGuiCommand(ws, cmd) {
  if (cmd.cmd === 'onair') {
    await request(ws, 'setOnAir', { streamId: STREAM_ID, onAir: !!cmd.value });
    console.log(`\u25b8 On Air: ${cmd.value ? 'ON' : 'OFF'}`);
  } else if (cmd.cmd === 'setAudioFrameMs') {
    if (!mainAudioHandle) {
      console.log('\u25b8 Audio buffer change ignored: no audio encoder running');
      return;
    }
    await mainAudioHandle.restart(cmd.value);
    console.log(`\u25b8 Audio buffer: ${cmd.value}ms`);
  } else if (cmd.cmd === 'setClockOverlay') {
    if (!mainVideoHandle) {
      console.log('\u25b8 Clock overlay change ignored: no video encoder running');
      return;
    }
    await mainVideoHandle.restart(!!cmd.value);
    console.log(`\u25b8 Clock overlay: ${cmd.value ? 'ON' : 'OFF'}`);
  } else if (cmd.cmd === 'setHls') {
    await request(ws, 'setHlsEnabled', { streamId: STREAM_ID, enabled: !!cmd.value });
    console.log(`\u25b8 HLS: ${cmd.value ? 'ON' : 'OFF'}`);
  }
}

/**
 * Return audio (Mic/PGM + Talkback), NAT-safe: the publisher consumes the viewer's
 * return-audio producers as a plain WebRTC peer (webrtcbin + TURN), same as a browser
 * viewer would. Spawns tools/return-audio-receiver.py and drives it over stdin/stdout JSON.
 *
 * PGM and Talkback each get their OWN independent WebRTC transport/ICE session
 * (createReturnTransport per kind) instead of sharing one bundled transport.
 * GStreamer's webrtcbin cannot reliably demux 2 recvonly transceivers sharing one
 * transport when both use the same codec — packets ended up on the wrong side
 * regardless of pad name/mid/mlineindex. Two separate connections remove all
 * ambiguity: everything on a given connection belongs to that connection's kind.
 */
async function startReturnAudio(ws, enabledKinds) {
  const caps = await request(ws, 'getRouterRtpCapabilities');
  const opusCodec = caps.rtpCapabilities.codecs.find(c => c.mimeType.toLowerCase() === 'audio/opus');
  if (!opusCodec) throw new Error('Router has no opus codec for return audio');
  await request(ws, 'setRtpCapabilities', { rtpCapabilities: caps.rtpCapabilities });

  // Windows' standard Python installer only provides "python.exe" (no
  // "python3" alias by default), unlike macOS/Homebrew which always exposes
  // python3 -- using a fixed 'python3' default here made return-audio
  // (PGM/Talkback) fail immediately on Windows with "spawn python3 ENOENT".
  const pythonBin = process.env.RETURN_AUDIO_PYTHON || (IS_WIN ? 'python' : 'python3');
  console.log(`\u25b8 Return-audio interpreter: ${pythonBin}`);
  const py = spawn(pythonBin, [path.join(__dirname, 'return-audio-receiver.py')], {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  py.stderr.on('data', (d) => process.stderr.write(`[return-audio] ${d}`));
  py.on('exit', (code) => console.log(`\u25b8 Return-audio receiver exited (code=${code})`));

  const transportsByKind = {};
  const PGM_MAX_SLOTS = 3;

  let lineBuf = '';
  py.stdout.on('data', (chunk) => {
    lineBuf += chunk.toString();
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      handlePythonEvent(event).catch(err =>
        console.log(`\u25b8 Return-audio event error (${event?.kind}): ${err.message}`));
    }
  });

  // `slot` only applies to kind='pgm' (up to PGM_MAX_SLOTS simultaneous speakers
  // sharing ONE WebRTC connection as distinct Consumers). For pgm, the consumer's
  // ssrc is forwarded to Python (as "expect-slot") BEFORE resumeConsumer unpauses
  // it server-side, so return-audio-receiver.py can match the resulting pad-added
  // to the right slot in its mixer purely from the RTP ssrc.
  async function consumeKind(kind, slot) {
    try {
      const result = await request(ws, 'consumeReturn', { streamId: STREAM_ID, kind, slot });
      if (result.empty) {
        if (kind === 'pgm' && Number.isInteger(slot)) {
          py.stdin.write(JSON.stringify({ cmd: 'stop-slot', kind, slot }) + '\n');
        }
        return; // no viewer producing this kind/slot yet (or anymore)
      }
      if (kind === 'pgm' && Number.isInteger(slot)) {
        const ssrc = result.rtpParameters?.encodings?.[0]?.ssrc;
        py.stdin.write(JSON.stringify({ cmd: 'expect-slot', kind, slot, ssrc }) + '\n');
      }
      await request(ws, 'resumeConsumer', { consumerId: result.id });
      console.log(`\u25b8 Return audio active: ${kind}${Number.isInteger(slot) ? ` slot=${slot}` : ''} ` +
        `(producer=${result.producerId})`);
    } catch (err) {
      console.log(`\u25b8 Return audio (${kind}${Number.isInteger(slot) ? ` slot=${slot}` : ''}) error: ${err.message}`);
    }
  }

  async function handlePythonEvent(event) {
    const kind = event.kind;
    if (event.event === 'answer') {
      const tData = transportsByKind[kind];
      if (!tData) return;
      await request(ws, 'connectTransport', { transportId: tData.id, dtlsParameters: event.dtlsParameters });
      console.log(`\u25b8 Return-audio WebRTC connected (${kind})`);
      if (kind === 'pgm') {
        // Query every slot at startup: any of the 3 could already have an active
        // speaker before this publish process (re)connected.
        for (let slot = 0; slot < PGM_MAX_SLOTS; slot++) await consumeKind(kind, slot);
      } else {
        await consumeKind(kind);
      }
    } else if (event.event === 'error') {
      console.log(`\u25b8 Return-audio receiver error (${kind}): ${event.message}`);
    } else if (event.event === 'ice-state') {
      console.log(`\u25b8 Return-audio ICE state (${kind}): ${event.state}`);
    }
  }

  onPush('returnProducerChanged', (msg) => {
    consumeKind(msg.kind, msg.kind === 'pgm' ? msg.slot : undefined);
  });

  // Admin adjusted one PGM speaker's volume from the viewer's admin panel.
  onPush('setPgmVolume', (msg) => {
    py.stdin.write(JSON.stringify({ cmd: 'setVolume', kind: 'pgm', slot: msg.slot, volume: msg.volume }) + '\n');
  });

  for (const kind of enabledKinds) {
    const tData = await request(ws, 'createReturnTransport', { kind });
    transportsByKind[kind] = tData;
    py.stdin.write(JSON.stringify({
      cmd: 'start',
      kind,
      transport: {
        iceParameters: tData.iceParameters,
        iceCandidates: tData.iceCandidates,
        dtlsParameters: tData.dtlsParameters,
      },
      iceServers: tData.iceServers,
      audioPayloadType: opusCodec.preferredPayloadType,
    }) + '\n');
  }

  return py;
}

async function main() {
  console.log('=== Winus Video Publisher ===');
  console.log(`  Server: ${SERVER}`);
  console.log(`  Stream: ${STREAM_ID} (${STREAM_NAME})`);
  console.log(`  Source: ${SOURCE} (device=${DEVICE}, index=${DEVICE_INDEX})`);
  console.log(`  Bitrate: ${BITRATE}kbps`);
  console.log('');

  const ws = new WebSocket(SERVER, { rejectUnauthorized: false });

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.requestId && pending.has(msg.requestId)) {
      pending.get(msg.requestId).resolve(msg);
      pending.delete(msg.requestId);
      return;
    }
    for (const listener of messageListeners) listener(msg);
  });

  // Auth
  const authToken = process.env.AUTH_TOKEN;
  if (!authToken) {
    safeExit(1, '\u2716 AUTH_TOKEN env required.');
    return;
  }
  ws.send(JSON.stringify({ type: 'auth', token: authToken, intent: 'publish' }));
  const authResp = await new Promise((resolve) => {
    const handler = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'auth_ok' || m.type === 'auth_error') {
        ws.removeListener('message', handler);
        resolve(m);
      }
    };
    ws.on('message', handler);
    setTimeout(() => resolve({ type: 'auth_error', error: 'timeout' }), 5000);
  });
  if (authResp.type === 'auth_error') {
    safeExit(1, `\u2716 Auth failed: ${authResp.error}`);
    return;
  }
  console.log(`\u25b8 Authenticated as ${authResp.role}`);
  listenForGuiCommands(ws);

  // Create video PlainTransport
  const transport = await request(ws, 'createPlainTransport', { streamId: STREAM_ID });
  let destIp = transport.ip === '0.0.0.0' ? '127.0.0.1' : transport.ip;
  const videoPort = transport.port;
  console.log(`\u25b8 Video: ${destIp}:${videoPort}`);

  // Create audio PlainTransport if audio enabled
  let audioPort = '';
  if (AUDIO_SOURCE !== 'none') {
    const at = await request(ws, 'createPlainTransport', { streamId: STREAM_ID, kind: 'audio' });
    audioPort = String(at.port);
    console.log(`\u25b8 Audio: ${destIp}:${audioPort}`);
  }

  // Start GStreamer (video, and -- ONLY for AUDIO_SOURCE='decklink_native:*'
  // -- audio too, embedded in the SAME process/pipeline, see
  // startVideoEncoder() docs above for why). For every other AUDIO_SOURCE,
  // audio is spawned separately below via startAudioEncoder(), uniformly
  // across platforms and source kinds, so the GUI's live "Buf" control can
  // restart just the audio encoder. Either way this video encoder is
  // independently restartable so the GUI's live clock-overlay toggle can
  // relaunch it (which, for the embedded-audio case, briefly restarts audio
  // too -- an accepted trade-off for avoiding the Decklink native-capture
  // conflict entirely).
  const audioIsDecklinkNative = AUDIO_SOURCE.startsWith('decklink_native:');
  mainVideoHandle = await startVideoEncoder(destIp, videoPort, {
    clockOverlay: CLOCK_OVERLAY === '1',
    audioPort: audioIsDecklinkNative ? audioPort : undefined,
  });

  // Wait for first RTP packet (comedia mode)
  await new Promise(r => setTimeout(r, 2000));

  // Start the audio encoder (all platforms, all source kinds) uniformly --
  // EXCEPT decklink_native, already embedded in the video pipeline above.
  // See startAudioEncoder() docs above for why this must otherwise run
  // independently of the video GStreamer process.
  if (audioPort && !audioIsDecklinkNative) {
    mainAudioHandle = await startAudioEncoder(destIp, audioPort, {
      source: AUDIO_SOURCE,
      device: process.env.AUDIO_DEVICE || '',
      channels: process.env.AUDIO_CH || '1-2',
      bitrate: AUDIO_BITRATE,
      frameMs: AUDIO_FRAME_MS,
    });
  }

  // Register video producer
  try {
    const produced = await request(ws, 'produce', {
      kind: 'video',
      // pgmEnabled/talkbackEnabled let the viewer hide the Mic/PGM or
      // Talkback button for streams where that channel isn't wired up on
      // the publisher (see the "Retorno" dialog's "Deshabilitado" option),
      // instead of showing a control that would silently do nothing.
      metadata: { streamName: STREAM_NAME, pgmEnabled: PGM_ENABLED, talkbackEnabled: TALKBACK_ENABLED },
      rtpParameters: {
        codecs: [{
          mimeType: 'video/H264',
          payloadType: 101,
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
          },
          rtcpFeedback: [
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
            { type: 'ccm', parameter: 'fir' },
          ],
        }],
        encodings: [{ ssrc: 1111 }],
      },
    });
    console.log(`\u25b8 Video producer: ${produced.producerId}`);
    // Parallel HLS output (WebOS/Smart TV) -- see HLS_ENABLED docs above.
    // Sent only after the video producer exists (the server can't start
    // consuming it otherwise); mediasoup-manager.js's hlsWanted tracking
    // also re-applies this automatically across republishes.
    if (HLS_ENABLED === '1') {
      try {
        await request(ws, 'setHlsEnabled', { streamId: STREAM_ID, enabled: true });
        console.log('\u25b8 HLS: ON');
      } catch (err) {
        console.log(`\u25b8 HLS enable error: ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`\u25b8 Video producer error: ${err.message}`);
  }

  // Register audio producer
  if (AUDIO_SOURCE !== 'none') {
    try {
      const ap = await request(ws, 'produce', {
        kind: 'audio',
        metadata: { streamName: STREAM_NAME },
        rtpParameters: {
          codecs: [{
            mimeType: 'audio/opus',
            payloadType: 100,
            clockRate: 48000,
            channels: 2,
            parameters: { useinbandfec: 1 },
          }],
          encodings: [{ ssrc: 2222 }],
        },
      });
      console.log(`\u25b8 Audio producer: ${ap.producerId}`);
    } catch (err) {
      console.log(`\u25b8 Audio producer error: ${err.message}`);
    }
  }

  // Return audio (Mic/PGM + Talkback), NAT-safe via WebRTC/TURN (see startReturnAudio)
  let returnAudioProc = null;
  const enabledKinds = ['pgm', 'talkback'].filter(k => (k === 'pgm' ? PGM_ENABLED : TALKBACK_ENABLED));
  if (RETURN_AUDIO_ENABLED === '1' && enabledKinds.length > 0) {
    try {
      returnAudioProc = await startReturnAudio(ws, enabledKinds);
    } catch (err) {
      console.log(`\u25b8 Return audio setup error: ${err.message}`);
    }
  } else if (RETURN_AUDIO_ENABLED === '1') {
    console.log('\u25b8 Return audio: both PGM and Talkback disabled for this channel, skipping');
  }

  const viewUrl = SERVER.replace('wss://', 'https://').replace('/ws', '');
  console.log('');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log(`  LIVE: ${STREAM_ID} (${STREAM_NAME})`);
  console.log(`  View: ${viewUrl}`);
  console.log('  Press Ctrl+C to stop');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');

  const keepalive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 15000);

  process.on('SIGINT', () => {
    clearInterval(keepalive);
    try { mainVideoHandle.kill('SIGINT'); } catch (_) {}
    try { if (returnAudioProc) returnAudioProc.kill('SIGINT'); } catch (_) {}
    try { if (mainAudioHandle) mainAudioHandle.kill('SIGINT'); } catch (_) {}
    try { ws.close(); } catch (_) {}
    safeExit(0, '\nStopping...');
  });

  // Admin "Forzar cierre" (see the WS 'forceUnpublish' handler in
  // signaling.js): the server has ALREADY torn down this stream's mediasoup
  // transports/producers by the time this arrives, so GStreamer would
  // otherwise just keep pushing RTP into a void forever with the GUI still
  // showing "Publishing" -- react the same way as a local Ctrl+C/Stop so the
  // GUI's process-exit handling picks it up and the row goes back to idle.
  onPush('forceStopped', (msg) => {
    clearInterval(keepalive);
    try { mainVideoHandle.kill('SIGTERM'); } catch (_) {}
    try { if (returnAudioProc) returnAudioProc.kill('SIGTERM'); } catch (_) {}
    try { if (mainAudioHandle) mainAudioHandle.kill('SIGTERM'); } catch (_) {}
    try { ws.close(); } catch (_) {}
    safeExit(0, `\u25b8 Stream cerrado a la fuerza por el admin${msg.by ? ` (${msg.by})` : ''}`);
  });

  mainVideoHandle.setFatalExitHandler((code, signal) => {
    clearInterval(keepalive);
    try { if (returnAudioProc) returnAudioProc.kill('SIGINT'); } catch (_) {}
    try { if (mainAudioHandle) mainAudioHandle.kill('SIGINT'); } catch (_) {}
    try { ws.close(); } catch (_) {}
    safeExit(code || 0, `GStreamer exited (code=${code}, signal=${signal})`);
  });
}

main().catch((err) => {
  safeExit(1, `Fatal: ${err && err.stack || err}`);
});
