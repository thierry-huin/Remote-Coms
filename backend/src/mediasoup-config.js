const os = require('os');

module.exports = {
  worker: {
    rtcMinPort: parseInt(process.env.RTP_MIN_PORT || '10201', 10),
    rtcMaxPort: parseInt(process.env.RTP_MAX_PORT || '10400', 10),
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp'],
  },
  // One worker per CPU core (video is heavier than audio)
  numWorkers: Math.min(os.cpus().length, 4),
  router: {
    mediaCodecs: [
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f', // Baseline 3.1
          'level-asymmetry-allowed': 1,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '4d0032', // Main 5.0 (high quality)
          'level-asymmetry-allowed': 1,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '640032', // High 5.0 (AMD AMF hardware encoder output)
          'level-asymmetry-allowed': 1,
        },
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
      },
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
    ],
  },
  webRtcTransport: {
    maxIncomingBitrate: 20_000_000, // 20 Mbps max
    initialAvailableOutgoingBitrate: 5_000_000, // 5 Mbps initial
  },
};
