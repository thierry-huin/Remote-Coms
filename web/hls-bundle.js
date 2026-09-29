// Bundle entry: expose hls.js as a global (same pattern as mediasoup-bundle.js)
const Hls = require('hls.js').default;
window.Hls = Hls;
