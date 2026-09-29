/**
 * SRT Relay Manager
 * Spawns srtsrc GStreamer processes to receive SRT streams and forward
 * them as plain RTP to mediasoup PlainTransport ports.
 *
 * For each PlainTransport, a relay is started:
 *   SRT port (publisher) → srtsrc → udpsink (localhost → mediasoup)
 */

const { spawn } = require('child_process');

// SRT port range (separate from mediasoup RTP range)
const SRT_MIN_PORT = parseInt(process.env.SRT_MIN_PORT || '10501', 10);
const SRT_MAX_PORT = parseInt(process.env.SRT_MAX_PORT || '10600', 10);

let nextSrtPort = SRT_MIN_PORT;
const relays = new Map(); // streamId -> { process, srtPort }

function allocateSrtPort() {
  const port = nextSrtPort;
  nextSrtPort++;
  if (nextSrtPort > SRT_MAX_PORT) nextSrtPort = SRT_MIN_PORT;
  return port;
}

/**
 * Start an SRT receiver that forwards to a mediasoup RTP port.
 * @param {string} streamId - Stream identifier
 * @param {number} mediasoupPort - mediasoup PlainTransport RTP port
 * @returns {number} SRT port to send to
 */
function startRelay(streamId, mediasoupPort) {
  stopRelay(streamId);

  const srtPort = allocateSrtPort();

  // srtsrc receives SRT, outputs raw RTP bytes, udpsink forwards to mediasoup
  const proc = spawn('gst-launch-1.0', [
    '-q',
    'srtsrc',
    `uri=srt://0.0.0.0:${srtPort}`,
    'latency=50',
    '!', 'udpsink',
    `host=127.0.0.1`,
    `port=${mediasoupPort}`,
    'sync=false',
    'async=false',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[SRT relay:${streamId}] ${msg}`);
  });
  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[SRT relay:${streamId}] ${msg}`);
  });

  proc.on('exit', (code) => {
    console.log(`[SRT relay:${streamId}] exited (code=${code})`);
    relays.delete(streamId);
  });

  relays.set(streamId, { process: proc, srtPort, mediasoupPort });
  console.log(`[SRT relay] ${streamId}: srt://0.0.0.0:${srtPort} → udp://127.0.0.1:${mediasoupPort}`);

  return srtPort;
}

/**
 * Stop the RIST relay for a stream.
 */
function stopRelay(streamId) {
  const relay = relays.get(streamId);
  if (relay) {
    try { relay.process.kill('SIGTERM'); } catch (_) {}
    relays.delete(streamId);
    console.log(`[SRT relay] ${streamId}: stopped`);
  }
}

/**
 * Stop all relays.
 */
function stopAll() {
  for (const [id, relay] of relays) {
    try { relay.process.kill('SIGTERM'); } catch (_) {}
  }
  relays.clear();
  console.log('[SRT relay] All relays stopped');
}

module.exports = { startRelay, stopRelay, stopAll };
