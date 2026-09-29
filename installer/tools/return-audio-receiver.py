#!/usr/bin/env python3
"""Winus Video — Return Audio Receiver (PGM + Talkback).

Connects to mediasoup as a plain WebRTC peer (no browser), using GStreamer's
`webrtcbin`, to receive the viewer's PGM/Talkback return audio. This traverses
NAT via the same TURN server already used by browser viewers — no fixed/
forwarded ports needed on the publisher machine.

Architecture: TWO fully independent WebRTC connections (one per kind), not
one shared/bundled connection carrying both. This is deliberate: GStreamer's
webrtcbin cannot reliably demux two recvonly transceivers that share one
bundled transport when both use the identical codec/payload type — in
practice, incoming RTP got attributed to the wrong transceiver regardless of
pad name, the transceiver's `mid` property, or its `mlineindex` property
(all three were tried and failed under real, sustained RTP flow — a fresh
local negotiation test showed correct values, but that didn't hold once
packets were actually flowing and producers were replaced over time). With a
separate ICE/DTLS session per kind there is nothing left to disambiguate:
every pad ever added on a given connection belongs to that connection's kind.
The extra cost is one additional ICE handshake at startup.

Ownership split: `publish.js` (Node) owns ALL WebSocket signaling with the
mediasoup server (createReturnTransport, connectTransport, consumeReturn,
resumeConsumer) — once per kind. This script only drives the local WebRTC/
GStreamer plumbing and talks to publish.js over stdin/stdout using one JSON
object per line, every message tagged with "kind".

IPC protocol
------------
stdin (from publish.js):
  {"cmd": "start", "kind": "pgm"|"talkback",
   "transport": {"iceParameters": {...}, "iceCandidates": [...], "dtlsParameters": {...}},
   "iceServers": [...],
   "audioPayloadType": 100}
  {"cmd": "stop", "kind": "pgm"|"talkback"}  # kind omitted = stop all

stdout (to publish.js):
  {"event": "answer", "kind": "pgm"|"talkback", "dtlsParameters": {"role": ..., "fingerprints": [...]}}
  {"event": "ice-state", "kind": "pgm"|"talkback", "state": "..."}
  {"event": "error", "kind": "pgm"|"talkback", "message": "..."}

Audio routing ("Tie-line"): by default, decoded PCM for each kind is routed
via `sounddevice` (PortAudio) to a specific output device and channel pair,
configured with PGM_OUTPUT_DEVICE/PGM_OUTPUT_CH and TALKBACK_OUTPUT_DEVICE/
TALKBACK_OUTPUT_CH (same index/name + "N-M" channel convention as
tools/audio_capture.py uses for input). This lets PGM and Talkback each land
on distinct channels of the same or different multichannel interface,
instead of colliding on the system's default output (which can disrupt an
unrelated input capture using the same physical device). If
PGM_AUDIO_SINK/TALKBACK_AUDIO_SINK is explicitly set, that raw GStreamer sink
string is used instead for that kind (advanced/scripting escape hatch).
"""
from __future__ import annotations

import json
import os
import sys
import threading

if sys.platform == "win32":
    # MSYS2/mingw64 Python (used here on Windows for PyGObject/GstWebRTC
    # support, see README) keeps ALL of its shared libraries -- GLib,
    # GStreamer, AND PortAudio -- next to python3.exe (mingw64\bin), rather
    # than in a separate system lib directory. When this interpreter is
    # spawned directly by tools/publish.js (not through an MSYS2 launcher
    # script), Python 3.8+'s restricted DLL search no longer automatically
    # includes that directory, which can make sounddevice's PortAudio lookup
    # fail ("No module named '_sounddevice_data'", its own pip-only fallback)
    # even though the real libportaudio DLL sits right next to the
    # interpreter. Explicitly register it before anything else loads.
    try:
        os.add_dll_directory(os.path.dirname(sys.executable))
    except (AttributeError, OSError):
        pass

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstWebRTC", "1.0")
gi.require_version("GstSdp", "1.0")
from gi.repository import Gst, GstSdp, GstWebRTC, GLib  # noqa: E402

Gst.init(None)

try:
    import numpy as np
    import sounddevice as sd
    _SD_AVAILABLE = True
except Exception as _sd_import_err:  # noqa: BLE001
    _SD_AVAILABLE = False
    _SD_IMPORT_ERROR = _sd_import_err

SAMPLE_RATE = 48000
CHANNELS_IN = 2  # PGM/Talkback are always decoded as stereo opus

# Low-latency tuning (PGM/Talkback are live comms, not playback -- a little
# extra glitching under bad network jitter is preferable to compounding
# delay). Both configurable via env vars in case a venue's network/hardware
# needs more slack.
JITTER_BUFFER_MS = int(os.environ.get("RETURN_AUDIO_JITTER_MS", "100"))
OUTPUT_BUFFER_MS = int(os.environ.get("RETURN_AUDIO_BUFFER_MS", "150"))

# Advanced escape hatch: if set, bypass the sounddevice router for that kind
# and use this raw GStreamer sink string instead (e.g. "autoaudiosink").
PGM_AUDIO_SINK_OVERRIDE = os.environ.get("PGM_AUDIO_SINK", "")
TALKBACK_AUDIO_SINK_OVERRIDE = os.environ.get("TALKBACK_AUDIO_SINK", "")

KINDS = ("pgm", "talkback")

# Up to this many simultaneous PGM speakers are mixed together (see
# ReturnAudioConnection's pgm-specific audiomixer path below). Must match
# backend/src/services/mediasoup-manager.js's PGM_MAX_SLOTS.
PGM_MAX_SLOTS = 3


def log(message: str) -> None:
    print(f"[return-audio] {message}", file=sys.stderr, flush=True)


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


# ======================== AUDIO OUTPUT ROUTER (sounddevice) ========================

if _SD_AVAILABLE:
    class RingBuffer:
        """Thread-safe float32 ring buffer for interleaved multi-channel frames.
        Written from the GStreamer thread (appsink), read from the PortAudio
        output callback thread. Drops the oldest data on overflow.

        `capacity` (from `seconds`) is a large SAFETY ceiling against network
        bursts, not the intended steady-state backlog -- `max_backlog_frames`
        (default: OUTPUT_BUFFER_MS worth) is actively enforced on every write
        by skipping `read_pos` forward, so any slow, silent drift between the
        writer's and reader's effective rates (e.g. PGM's audiomixer paces
        its output against the pipeline clock, a separate clock domain from
        sounddevice/PortAudio's own callback timing -- unlike Talkback, which
        has no such intermediate re-clocking stage) can only ever compound the
        backlog up to that small target, instead of being free to creep
        upward without bound all the way to the full `capacity` (this is what
        made PGM's return-audio noticeably more delayed than Talkback's, and
        made it worse the longer a stream stayed connected)."""

        def __init__(self, seconds: float = OUTPUT_BUFFER_MS / 1000.0, channels: int = CHANNELS_IN,
                     samplerate: int = SAMPLE_RATE, max_backlog_ms: float = OUTPUT_BUFFER_MS):
            self.channels = channels
            self.capacity = int(seconds * samplerate)
            self.max_backlog_frames = min(self.capacity, int(max_backlog_ms / 1000.0 * samplerate))
            self.buf = np.zeros((self.capacity, channels), dtype=np.float32)
            self.write_pos = 0
            self.read_pos = 0
            self.filled = 0
            self.lock = threading.Lock()

        def write(self, data: "np.ndarray") -> None:
            n = data.shape[0]
            with self.lock:
                if n >= self.capacity:
                    data = data[-self.capacity:]
                    n = data.shape[0]
                end = self.write_pos + n
                if end <= self.capacity:
                    self.buf[self.write_pos:end] = data
                else:
                    first = self.capacity - self.write_pos
                    self.buf[self.write_pos:] = data[:first]
                    self.buf[:end - self.capacity] = data[first:]
                self.write_pos = end % self.capacity
                self.filled = min(self.capacity, self.filled + n)
                if self.filled >= self.capacity:
                    self.read_pos = self.write_pos  # drop oldest
                elif self.filled > self.max_backlog_frames:
                    # Actively catch up to the target backlog instead of
                    # letting accumulated drift silently grow the playback
                    # delay -- see class docstring.
                    skip = self.filled - self.max_backlog_frames
                    self.read_pos = (self.read_pos + skip) % self.capacity
                    self.filled = self.max_backlog_frames

        def read(self, n: int) -> "np.ndarray":
            out = np.zeros((n, self.channels), dtype=np.float32)
            with self.lock:
                avail = min(n, self.filled)
                if avail > 0:
                    end = self.read_pos + avail
                    if end <= self.capacity:
                        out[:avail] = self.buf[self.read_pos:end]
                    else:
                        first = self.capacity - self.read_pos
                        out[:first] = self.buf[self.read_pos:]
                        out[first:avail] = self.buf[:end - self.capacity]
                    self.read_pos = end % self.capacity
                    self.filled -= avail
            return out


    class OutputDeviceRouter:
        """One sounddevice.OutputStream per physical device, mixing multiple
        logical channels (pgm/talkback) into their configured channel offsets
        so PGM and Talkback can safely share one multichannel interface."""

        _routers: dict = {}
        _routers_lock = threading.Lock()

        def __init__(self, device_index: int, num_channels: int):
            self.device_index = device_index
            self.num_channels = num_channels
            self.slots: dict = {}  # name -> (RingBuffer, [dest_channel_indices])
            self.lock = threading.Lock()
            self.stream = sd.OutputStream(
                device=device_index, channels=num_channels, samplerate=SAMPLE_RATE,
                dtype="float32", blocksize=960, latency="low", callback=self._callback,
            )
            self.stream.start()

        def _callback(self, outdata, frames, _time_info, status) -> None:
            if status:
                log(f"sounddevice output status (device #{self.device_index}): {status}")
            outdata[:] = 0
            with self.lock:
                slots = list(self.slots.values())
            for ring, dest in slots:
                block = ring.read(frames)
                if len(dest) == 1:
                    outdata[:, dest[0]] += block.mean(axis=1)
                else:
                    outdata[:, dest[0]] += block[:, 0]
                    outdata[:, dest[1]] += block[:, 1]
            np.clip(outdata, -1.0, 1.0, out=outdata)

        def add_channel(self, name: str, ring: "RingBuffer", dest_channels: list) -> None:
            with self.lock:
                self.slots[name] = (ring, dest_channels)

        @classmethod
        def get_or_create(cls, device_index: int, num_channels: int) -> "OutputDeviceRouter":
            with cls._routers_lock:
                existing = cls._routers.get(device_index)
                if existing and existing.num_channels >= num_channels:
                    return existing
                if existing:
                    try:
                        existing.stream.stop()
                        existing.stream.close()
                    except Exception:  # noqa: BLE001
                        pass
                router = cls(device_index, num_channels)
                cls._routers[device_index] = router
                return router


    def _resolve_output_device(dev_str: str):
        """Resolve a device index/name (or "" for system default) to (index, info)."""
        devices = sd.query_devices()
        if not dev_str:
            idx = sd.default.device[1] if sd.default.device else -1
            if idx is not None and idx >= 0:
                return idx, devices[idx]
            for i, d in enumerate(devices):
                if d["max_output_channels"] > 0:
                    return i, d
            raise RuntimeError("No output audio device available")
        try:
            idx = int(dev_str)
            return idx, devices[idx]
        except ValueError:
            search = dev_str.lower()
            for i, d in enumerate(devices):
                if search in d["name"].lower() and d["max_output_channels"] > 0:
                    return i, d
            raise RuntimeError(f"Output device not found: {dev_str}")



# _parse_output_channels lives at module scope (not gated behind
# `if _SD_AVAILABLE:`) since the Windows native-GStreamer output path
# (_link_gst_native_output) needs it too, regardless of whether
# sounddevice/numpy imported successfully.
def _parse_output_channels(ch_str: str) -> list:
    """Parse "3-4" / "3,4" / "3" into 0-based destination channel indices
    (up to 2: left/right; a single value mixes both to mono on that channel)."""
    ch_str = (ch_str or "1-2").replace("-", ",")
    nums = [int(c.strip()) - 1 for c in ch_str.split(",") if c.strip()]
    if not nums:
        nums = [0, 1]
    return nums[:2]


# Windows audio backend for return-audio output: "wasapi" (default) or
# "directsound". Some virtual "audio matrix" drivers (e.g. VB-Audio Matrix)
# reset their whole internal engine -- invalidating any other already-open
# WASAPI client, such as the main outgoing audio capture -- the moment a new
# WASAPI client (like our return-audio output) attaches to any of their
# ports. DirectSound goes through a different, older Windows audio path and
# may avoid triggering that reset on such drivers.
WIN_AUDIO_API = os.environ.get("RETURN_AUDIO_WIN_API", "wasapi").strip().lower()
_WIN_SINK_FACTORY = {"wasapi": "wasapisink", "directsound": "directsoundsink"}.get(WIN_AUDIO_API, "wasapisink")


def _resolve_gst_output_device(name_substr: str, factory_name: str = _WIN_SINK_FACTORY):
    """Find a GStreamer Audio/Sink device whose display name contains
    name_substr (case-insensitive). Prefers a match backed by the requested
    sink factory ("wasapisink" or "directsoundsink", via RETURN_AUDIO_WIN_API)
    since the same physical device is often listed once per backend/API --
    but falls back to ANY other backend with a matching device rather than
    failing outright: some virtual audio drivers (e.g. VB-Audio Matrix, Dante
    Virtual Soundcard) only enumerate correctly through one specific Windows
    audio API even though the device itself works fine through it, and
    hard-failing there made PGM/Talkback output silently non-functional on
    otherwise-working setups. Returns None (meaning: let the sink element
    pick the system default) if name_substr is empty. Raises only if
    name_substr matches no Audio/Sink device at all."""
    if not name_substr:
        return None
    monitor = Gst.DeviceMonitor.new()
    monitor.add_filter("Audio/Sink", None)
    monitor.start()
    try:
        devices = monitor.get_devices()
    finally:
        monitor.stop()
    matched = []
    for d in devices:
        if name_substr.lower() not in d.get_display_name().lower():
            continue
        el = d.create_element(None)
        el_factory = el.get_factory().get_name() if el and el.get_factory() else None
        matched.append((d, el_factory))
    if not matched:
        names = [d.get_display_name() for d in devices]
        raise RuntimeError(f"Output device not found: {name_substr!r} (available: {names})")
    for d, el_factory in matched:
        if el_factory == factory_name:
            return d
    fallback_device, fallback_factory = matched[0]
    log(f"Output device {name_substr!r} not available via {factory_name}; "
        f"falling back to {fallback_factory} "
        f"(found via: {[(dd.get_display_name(), ff) for dd, ff in matched]})")
    return fallback_device


def _build_mix_matrix(dest_channels: list, num_out: int) -> str:
    """Build an `audiomixmatrix` `matrix` property string (gst_parse_launch
    syntax, e.g. "<<1.0,0.0>,<0.0,1.0>>") that places a decoded stereo (2ch)
    PGM/Talkback stream onto dest_channels (0-based, 1 or 2 entries) of a
    num_out-channel output, silencing every other output channel. Mirrors
    the same channel convention already used by the sounddevice-based
    router on macOS/Linux (_link_sounddevice_router's OutputDeviceRouter),
    so the SAME PGM_OUTPUT_CH/TALKBACK_OUTPUT_CH values behave the same way
    on every OS."""
    rows = []
    for out_ch in range(num_out):
        if len(dest_channels) == 1:
            gains = ("0.5", "0.5") if out_ch == dest_channels[0] else ("0.0", "0.0")
        else:
            left = "1.0" if out_ch == dest_channels[0] else "0.0"
            right = "1.0" if out_ch == dest_channels[1] else "0.0"
            gains = (left, right)
        rows.append(f"<{gains[0]},{gains[1]}>")
    return "<" + ",".join(rows) + ">"


# ======================== WEBRTC CONNECTION (one per kind) ========================

class ReturnAudioConnection:
    """One independent WebRTC peer connection (own ICE/DTLS session, own
    webrtcbin) dedicated to exactly one return-audio kind. See module
    docstring for why this is separate per kind rather than bundled."""

    def __init__(self, kind: str):
        self.kind = kind
        self.pipe = Gst.Pipeline.new(f"return-audio-{kind}")
        self.webrtc = Gst.ElementFactory.make("webrtcbin", f"webrtc-{kind}")
        if not self.webrtc:
            raise RuntimeError("webrtcbin element not available (install gstreamer1.0-plugins-bad)")
        self.webrtc.set_property("bundle-policy", "max-bundle")
        self.webrtc.set_property("latency", JITTER_BUFFER_MS)
        self.pipe.add(self.webrtc)
        self.webrtc.connect("pad-added", self._on_pad_added)
        self.webrtc.connect("notify::ice-connection-state", self._on_ice_state)
        # Elements linked to the CURRENTLY active pad (torn down and replaced
        # on every new pad-added, see _teardown_output). A new pad fires each
        # time the underlying viewer producer changes (e.g. someone else takes
        # over PGM/Talkback after the previous viewer disconnected) -- this
        # connection itself stays up across all of that.
        self._output_elements: list = []
        # Included in each pad's element names so a NEW pad's elements never
        # collide with the PREVIOUS pad's (GStreamer requires unique element
        # names within a bin). Without this, e.g. a second "sink-pgm" element
        # from a later reconnect silently failed to even be added to the
        # pipeline (the add() return value wasn't checked), breaking PGM/
        # Talkback output until the whole publish process was restarted.
        self._pad_seq = 0

        # PGM only: up to PGM_MAX_SLOTS speakers share this ONE connection as
        # distinct Consumers/SSRCs (mediasoup supports several Consumers over
        # one WebRtcTransport; webrtcbin surfaces each as its own src pad on
        # pad-added, demultiplexed internally by SSRC). Each slot gets its own
        # decode+volume branch feeding a persistent `audiomixer`, whose fixed
        # downstream output (built once, see _setup_pgm_final_output) is NEVER
        # torn down -- only per-slot input branches come and go independently
        # of each other. Talkback keeps the original single-output model.
        self._pgm_slots: dict = {}  # slot -> {"bin":, "mixer_pad":, "volume_el":}
        self._pgm_expected_ssrc: dict = {}  # slot -> expected ssrc (int), set via "expect-slot"
        # slot -> last volume set by the admin (see set_pgm_slot_volume), kept even
        # while the slot is empty/torn down so it survives the SAME speaker
        # reconnecting (a fresh GStreamer `volume` element otherwise always starts
        # back at unity gain -- the admin's slider setting would silently "stop
        # working" the moment that commentator's producer was recreated).
        self._pgm_slot_volume: dict = {}
        self._pgm_mixer = None
        if self.kind == "pgm":
            self._pgm_mixer = Gst.ElementFactory.make("audiomixer", "pgm-mixer")
            # GstAggregator (audiomixer's base class) imposes its own extra
            # buffering/alignment latency by default, on top of webrtcbin's
            # jitter buffer -- unlike Talkback, which has no mixer stage at
            # all and goes straight from decode to output. This is what made
            # PGM noticeably more delayed than Talkback even with the same
            # JITTER_BUFFER_MS. Forcing it to 0 removes that extra margin;
            # safe here since PGM_MAX_SLOTS speakers all originate from the
            # SAME webrtcbin (already jitter-buffered/aligned upstream), so
            # there's no meaningfully different per-slot arrival lag left for
            # the mixer to compensate for.
            self._pgm_mixer.set_property("latency", 0)
            self.pipe.add(self._pgm_mixer)
            self._setup_pgm_final_output()

        bus = self.pipe.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self._on_bus_message)

    # ── Setup ──
    def _add_ice_servers(self, ice_servers: list) -> None:
        for server in ice_servers or []:
            urls = server.get("urls") or []
            if isinstance(urls, str):
                urls = [urls]
            for url in urls:
                if url.startswith("stun:"):
                    self.webrtc.set_property("stun-server", url)
                elif url.startswith("turn:"):
                    username = server.get("username", "")
                    credential = server.get("credential", "")
                    rest = url[len("turn:"):]
                    turn_uri = f"turn://{username}:{credential}@{rest}"
                    self.webrtc.emit("add-turn-server", turn_uri)

    def _build_offer_sdp(self, transport: dict, audio_pt: int) -> str:
        """Build a synthetic SDP "offer" representing mediasoup's WebRtcTransport
        (mediasoup itself doesn't speak SDP; this mirrors what mediasoup-client's
        browser handlers construct from the same transport parameters). Just
        ONE m= line here — this connection carries only `self.kind`."""
        ice = transport["iceParameters"]
        dtls = transport["dtlsParameters"]
        candidates = transport["iceCandidates"]
        fp = next((f for f in dtls["fingerprints"] if f["algorithm"] == "sha-256"), dtls["fingerprints"][0])

        lines = [
            "v=0",
            "o=winus-video 10000 1 IN IP4 0.0.0.0",
            "s=-",
            "t=0 0",
            "a=ice-lite",
            "a=msid-semantic: WMS *",
            f"a=group:BUNDLE {self.kind}",
            f"m=audio 9 UDP/TLS/RTP/SAVPF {audio_pt}",
            "c=IN IP4 0.0.0.0",
            f"a=rtpmap:{audio_pt} opus/48000/2",
            "a=sendonly",  # from mediasoup's POV: it sends this return-audio channel to us
            f"a=mid:{self.kind}",
            f"a=ice-ufrag:{ice['usernameFragment']}",
            f"a=ice-pwd:{ice['password']}",
            "a=setup:actpass",
            f"a=fingerprint:{fp['algorithm']} {fp['value']}",
            "a=rtcp-mux",
        ]
        for c in candidates:
            cand_line = (
                f"a=candidate:{c['foundation']} 1 {c['protocol']} {c['priority']} "
                f"{c['ip']} {c['port']} typ {c['type']}"
            )
            if c.get("tcpType"):
                cand_line += f" tcptype {c['tcpType']}"
            lines.append(cand_line)
        lines.append("a=end-of-candidates")
        return "\r\n".join(lines) + "\r\n"

    @staticmethod
    def _extract_dtls_params(answer_sdp_text: str) -> dict:
        role = "server"
        algo = "sha-256"
        value = None
        for line in answer_sdp_text.splitlines():
            line = line.strip()
            if line.startswith("a=setup:"):
                setup = line.split(":", 1)[1]
                role = "client" if setup == "active" else "server"
            elif line.startswith("a=fingerprint:"):
                algo, value = line[len("a=fingerprint:"):].split(" ", 1)
        return {"role": role, "fingerprints": [{"algorithm": algo, "value": value}]}

    def start(self, transport: dict, ice_servers: list, audio_pt: int) -> None:
        self._add_ice_servers(ice_servers)

        offer_text = self._build_offer_sdp(transport, audio_pt)
        log(f"[{self.kind}] Remote (offer) SDP representing mediasoup:\n" + offer_text)
        ok, sdpmsg = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(offer_text.encode("utf-8"), sdpmsg)
        offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, sdpmsg)

        p1 = Gst.Promise.new()
        self.webrtc.emit("set-remote-description", offer, p1)
        p1.wait()

        p2 = Gst.Promise.new()
        self.webrtc.emit("create-answer", None, p2)
        p2.wait()
        reply = p2.get_reply()
        answer = reply.get_value("answer")

        p3 = Gst.Promise.new()
        self.webrtc.emit("set-local-description", answer, p3)
        p3.wait()

        answer_text = answer.sdp.as_text()
        log(f"[{self.kind}] Local (answer) SDP:\n" + answer_text)

        dtls_params = self._extract_dtls_params(answer_text)
        emit({"event": "answer", "kind": self.kind, "dtlsParameters": dtls_params})

    def stop(self) -> None:
        self.pipe.set_state(Gst.State.NULL)

    # ── Incoming media ──
    def _teardown_output(self) -> None:
        """Remove the previous pad's output chain from the pipeline before
        linking a new one (see _pad_seq comment in __init__ for why this is
        needed on every reconnect, not just once at startup)."""
        for el in self._output_elements:
            try:
                el.set_state(Gst.State.NULL)
                self.pipe.remove(el)
            except Exception:  # noqa: BLE001
                pass
        self._output_elements = []

    # ── PGM multi-slot mixer (see _pgm_slots/_pgm_mixer comment in __init__) ──
    def _setup_pgm_final_output(self) -> None:
        """Build the mixer's fixed downstream output chain ONCE, at connection
        startup -- unlike the per-pad output model used for talkback (and
        used for PGM itself before multi-slot support), the mixer's output
        never needs to be replaced; only its upstream per-slot inputs come
        and go (see _link_pgm_slot/_teardown_pgm_slot)."""
        mixer_src = self._pgm_mixer.get_static_pad("src")
        prefix = "audioconvert ! audioresample"
        if PGM_AUDIO_SINK_OVERRIDE:
            log(f"[pgm] final output -> raw sink={PGM_AUDIO_SINK_OVERRIDE}")
            self._link_raw_sink(mixer_src, PGM_AUDIO_SINK_OVERRIDE, prefix=prefix)
            return
        if sys.platform == "win32":
            log("[pgm] final output: routing via native GStreamer sink")
            self._link_gst_native_output(mixer_src, prefix=prefix)
            return
        if not _SD_AVAILABLE:
            log(f"[pgm] final output: sounddevice/numpy not available ({_SD_IMPORT_ERROR}); "
                "falling back to autoaudiosink")
            self._link_raw_sink(mixer_src, "autoaudiosink", prefix=prefix)
            return
        log("[pgm] final output: routing via sounddevice")
        self._link_sounddevice_router(mixer_src, prefix=prefix)

    def expect_pgm_slot(self, slot: int, ssrc) -> None:
        """Record the SSRC mediasoup is about to send for `slot` (from the
        Consumer's own rtpParameters, forwarded by publish.js) BEFORE that
        Consumer is resumed server-side, so the eventual pad-added for it can
        be matched back to this slot (see _on_pgm_pad_added)."""
        if ssrc is None:
            self._pgm_expected_ssrc.pop(slot, None)
        else:
            self._pgm_expected_ssrc[slot] = int(ssrc)

    def set_pgm_slot_volume(self, slot: int, volume: float) -> None:
        volume = max(0.0, volume)
        self._pgm_slot_volume[slot] = volume
        entry = self._pgm_slots.get(slot)
        if entry and entry.get("volume_el") is not None:
            entry["volume_el"].set_property("volume", volume)

    def _teardown_pgm_slot(self, slot: int) -> None:
        """Remove one speaker's input branch from the mixer without touching
        the other (up to 2) active speakers or the mixer's own output."""
        entry = self._pgm_slots.pop(slot, None)
        if not entry:
            return
        try:
            entry["bin"].set_state(Gst.State.NULL)
            self.pipe.remove(entry["bin"])
        except Exception:  # noqa: BLE001
            pass
        try:
            self._pgm_mixer.release_request_pad(entry["mixer_pad"])
        except Exception:  # noqa: BLE001
            pass
        log(f"[pgm] slot {slot}: torn down")

    def _link_pgm_slot(self, pad: Gst.Pad, slot: int) -> None:
        self._teardown_pgm_slot(slot)  # replace any stale branch for this slot first
        vol_name = f"vol-pgm-{slot}"
        bin_desc = (
            "rtpopusdepay ! opusdec ! audioconvert ! audioresample "
            f"! audio/x-raw,format=F32LE,rate={SAMPLE_RATE},channels={CHANNELS_IN} "
            f"! volume name={vol_name}"
        )
        try:
            audio_bin = Gst.parse_bin_from_description(bin_desc, True)
        except GLib.Error as e:
            log(f"[pgm] slot {slot}: failed to build input chain: {e}")
            emit({"event": "error", "kind": "pgm", "message": f"slot {slot} decode error: {e}"})
            return
        self.pipe.add(audio_bin)
        mixer_pad = self._pgm_mixer.request_pad_simple("sink_%u")
        if mixer_pad is None:
            log(f"[pgm] slot {slot}: failed to get a mixer request pad")
            emit({"event": "error", "kind": "pgm", "message": f"slot {slot}: no mixer pad available"})
            try:
                self.pipe.remove(audio_bin)
            except Exception:  # noqa: BLE001
                pass
            return
        # Registered as soon as everything is in the pipeline (not only on full
        # success below) so a failure below can still be torn down cleanly,
        # same rationale as the talkback path's _output_elements bookkeeping.
        self._pgm_slots[slot] = {
            "bin": audio_bin, "mixer_pad": mixer_pad, "volume_el": audio_bin.get_by_name(vol_name),
        }
        # Re-apply whatever volume the admin last set for this slot (default:
        # unity gain) -- otherwise every new/reconnected speaker's branch would
        # silently reset to 1.0 regardless of the admin panel's slider position.
        self._pgm_slots[slot]["volume_el"].set_property("volume", self._pgm_slot_volume.get(slot, 1.0))
        audio_bin.sync_state_with_parent()
        link1 = pad.link(audio_bin.get_static_pad("sink"))
        if link1 != Gst.PadLinkReturn.OK:
            log(f"[pgm] slot {slot}: failed to link webrtcbin pad to input chain: {link1}")
            emit({"event": "error", "kind": "pgm", "message": f"slot {slot}: pad link failed: {link1}"})
            self._teardown_pgm_slot(slot)
            return
        link2 = audio_bin.get_static_pad("src").link(mixer_pad)
        if link2 != Gst.PadLinkReturn.OK:
            log(f"[pgm] slot {slot}: failed to link input chain to mixer: {link2}")
            emit({"event": "error", "kind": "pgm", "message": f"slot {slot}: mixer link failed: {link2}"})
            self._teardown_pgm_slot(slot)
            return
        log(f"[pgm] slot {slot}: active (ssrc match)")

    def _on_pgm_pad_added(self, pad: Gst.Pad) -> None:
        caps = pad.get_current_caps()
        ssrc = None
        if caps and caps.get_size() > 0:
            ok, value = caps.get_structure(0).get_uint("ssrc")
            if ok:
                ssrc = value
        slot = next((s for s, expected in self._pgm_expected_ssrc.items() if expected == ssrc), None)
        if slot is None:
            log(f"[pgm] pad-added: could not match ssrc={ssrc} to any expected slot "
                f"(expected={self._pgm_expected_ssrc}); ignoring pad {pad.get_name()}")
            return
        log(f"[pgm] pad-added: {pad.get_name()} ssrc={ssrc} -> slot={slot}")
        self._link_pgm_slot(pad, slot)

    def _on_pad_added(self, _webrtc, pad: Gst.Pad) -> None:
        if pad.direction != Gst.PadDirection.SRC:
            return
        if self.kind == "pgm":
            self._on_pgm_pad_added(pad)
            return
        self._teardown_output()
        self._pad_seq += 1
        raw_override = TALKBACK_AUDIO_SINK_OVERRIDE

        if raw_override:
            # Advanced escape hatch: explicit raw GStreamer sink, bypass sounddevice router.
            log(f"[{self.kind}] pad-added: {pad.get_name()} -> raw sink={raw_override}")
            self._link_raw_sink(pad, raw_override)
            return

        if sys.platform == "win32":
            # Windows always uses the native GStreamer sink path (WASAPI), never
            # sounddevice/PortAudio. This process runs under MSYS2's mingw64
            # Python (needed for PyGObject/GstWebRTC), where sounddevice's
            # bundled PortAudio fallback ("_sounddevice_data", PyPI-wheel-only)
            # isn't installed and MSYS2's own libportaudio DLL isn't reliably
            # discoverable by sounddevice's internal name-based lookup. GStreamer's
            # own audio sinks work fine here since webrtcbin/GStreamer already do.
            log(f"[{self.kind}] pad-added: {pad.get_name()}, routing via native GStreamer sink")
            self._link_gst_native_output(pad)
            return

        if not _SD_AVAILABLE:
            log(f"[{self.kind}] pad-added: {pad.get_name()}: sounddevice/numpy not available "
                f"({_SD_IMPORT_ERROR}); falling back to autoaudiosink")
            self._link_raw_sink(pad, "autoaudiosink")
            return

        log(f"[{self.kind}] pad-added: {pad.get_name()}, routing via sounddevice")
        self._link_sounddevice_router(pad)

    def _link_gst_native_output(self, pad: Gst.Pad,
                                 prefix: str = "rtpopusdepay ! opusdec ! audioconvert ! audioresample") -> None:
        """Windows path: decode straight into a native GStreamer audio sink
        (WASAPI/WASAPI2/DirectSound), resolved by device NAME substring
        (PGM_OUTPUT_DEVICE / TALKBACK_OUTPUT_DEVICE, e.g. a VB-Audio Matrix or
        Dante Virtual Soundcard name) — same env vars as the sounddevice
        router uses on macOS/Linux, just interpreted as a name instead of a
        numeric index here. Also honors PGM_OUTPUT_CH/TALKBACK_OUTPUT_CH (same
        "N"/"N-M" convention) via `audiomixmatrix`, so PGM and Talkback can
        each land on a distinct channel pair of the SAME multichannel
        interface instead of both always landing on channels 1-2. Each kind
        still opens its OWN dedicated output stream (Windows' shared-mode
        audio engine mixes multiple simultaneous streams to one device).

        `prefix` is the bin description feeding this method's `pad`: the
        default decodes raw RTP directly (talkback, and PGM's own per-pad
        path before the multi-slot mixer existed); PGM's persistent final
        output (see _setup_pgm_final_output) instead passes a `pad` that is
        the audiomixer's own (already-decoded, already-mixed) src pad, with
        prefix="audioconvert ! audioresample" -- no depay/decode needed."""
        device_env = "PGM_OUTPUT_DEVICE" if self.kind == "pgm" else "TALKBACK_OUTPUT_DEVICE"
        ch_env = "PGM_OUTPUT_CH" if self.kind == "pgm" else "TALKBACK_OUTPUT_CH"
        max_ch_env = "PGM_OUTPUT_MAX_CH" if self.kind == "pgm" else "TALKBACK_OUTPUT_MAX_CH"
        sink_name = f"sink-{self.kind}-{self._pad_seq}"
        ch_default = "1" if self.kind == "pgm" else "2"
        name_substr = os.environ.get(device_env, "")
        dest_channels = _parse_output_channels(os.environ.get(ch_env, ch_default))
        # Only trust the GUI-detected device channel count (PGM_OUTPUT_MAX_CH/
        # TALKBACK_OUTPUT_MAX_CH) when PGM and Talkback are actually
        # configured to the SAME physical device -- i.e. genuinely sharing
        # one multichannel interface via distinct channel offsets. This
        # detected count reflects the DRIVER'S DECLARED capability (e.g. "this
        # VAIO can go up to 8ch"), which some virtual "audio matrix" drivers
        # report regardless of what channel count the user currently has it
        # configured for in their OWN control panel -- confirmed stale here
        # (still reported 8ch after being reconfigured back to 2ch). Using it
        # unconditionally forced the untested/unstable shared-device pipeline
        # even for the plain, previously-confirmed-working "separate 2ch VAIO
        # per kind" setup, where it's not needed at all: max(dest_channels)+1
        # is already exactly right when there's no sharing to account for.
        other_device_env = "TALKBACK_OUTPUT_DEVICE" if self.kind == "pgm" else "PGM_OUTPUT_DEVICE"
        sharing_device = bool(name_substr) and name_substr == os.environ.get(other_device_env, "")
        device_max_ch = 0
        if sharing_device:
            try:
                device_max_ch = int(os.environ.get(max_ch_env, "") or 0)
            except ValueError:
                device_max_ch = 0
        num_out = max(device_max_ch, max(dest_channels) + 1)
        try:
            device = _resolve_gst_output_device(name_substr)
            sink = device.create_element(sink_name) if device else \
                Gst.ElementFactory.make(_WIN_SINK_FACTORY, sink_name)
            if sink is None:
                raise RuntimeError(f"could not create a {_WIN_SINK_FACTORY} element")
        except Exception as e:  # noqa: BLE001
            log(f"{self.kind}: native output device setup failed: {e}")
            emit({"event": "error", "kind": self.kind, "message": f"output device error: {e}"})
            return

        # Use the plain decode->sink pipeline (no `audiomixmatrix`, no forced
        # sample-format capsfilter) only when the device is genuinely just a
        # plain CHANNELS_IN-channel (stereo) device -- i.e. there is nothing
        # to position, dest_channels is its only 2 channels, in order. This
        # mirrors the simpler, previously-working configuration (PGM and
        # Talkback each on their OWN dedicated 2-channel VAIO). Checking
        # `num_out` here (not just dest_channels) matters: on a SHARED wider
        # device (e.g. 8ch VAIO with PGM on "1-2"), dest_channels is still
        # [0,1] but num_out is 8, so this must NOT take the simple path (that
        # previously let audioconvert freely upmix stereo across all 8 real
        # channels instead of positioning it onto just 1-2).
        # The `audiomixmatrix`/forced-format path below is reserved for the
        # advanced case of sharing ONE bigger multichannel interface between
        # PGM and Talkback via distinct channel offsets (e.g. PGM on 1-2,
        # Talkback on 3-4 of the SAME device) -- extra pipeline complexity
        # that isn't needed, and was never validated to help, in the common
        # separate-device-per-kind setup.
        if num_out == CHANNELS_IN and dest_channels == list(range(CHANNELS_IN)):
            bin_desc = prefix
        else:
            # Do NOT force a specific sample format (e.g. a fixed bit depth):
            # a previous attempt at forcing 24-bit (S24_32LE/S24LE) to match
            # an assumed engine-wide format caused a SILENT link failure on
            # an 8-channel-configured VAIO that apparently doesn't support
            # either of those exact formats at 8 channels -- `.link()`'s
            # return value wasn't checked, so the pad was left unlinked with
            # no error, only surfacing much later as a cryptic "not-linked"
            # flow error deep inside webrtcbin once real RTP data arrived.
            # Leave the format unconstrained (only rate+channels) so caps
            # negotiation with `audioconvert` picks whatever this specific
            # sink actually supports, exactly like the plain/simple path
            # above already does successfully.
            # `audiomixmatrix` places the decoded stereo pair onto dest_channels
            # of a num_out-channel stream, silencing every other output channel,
            # so PGM/Talkback can land on distinct channels of one interface.
            # NOTE: a bare `audio/x-raw,...` caps string only works as an implicit
            # capsfilter when gst_parse sees another element AFTER it; as the very
            # last token (nothing following it) it instead tries to instantiate an
            # element literally named "audio" and fails ("no element \"audio\""),
            # leaving this pad permanently unlinked. Use an explicit `capsfilter`
            # element instead for the FINAL caps, which works in any position.
            matrix = _build_mix_matrix(dest_channels, num_out)
            bin_desc = (
                f"{prefix} "
                f"! audio/x-raw,rate={SAMPLE_RATE},channels={CHANNELS_IN} "
                f'! audiomixmatrix in-channels={CHANNELS_IN} out-channels={num_out} matrix="{matrix}" '
                "! audioconvert "
                f'! capsfilter caps="audio/x-raw,rate={SAMPLE_RATE},channels={num_out}"'
            )
        try:
            audio_bin = Gst.parse_bin_from_description(bin_desc, True)
        except GLib.Error as e:
            log(f"[{self.kind}] Failed to build decode bin: {e}")
            emit({"event": "error", "kind": self.kind, "message": f"decode bin error: {e}"})
            return
        self.pipe.add(audio_bin)
        self.pipe.add(sink)
        # Registered as soon as both elements are in the pipeline (not only on
        # full success below) so that if a link fails just after this, the
        # _teardown_output() calls in those failure branches actually find
        # and remove these two instead of leaking them into the next attempt.
        self._output_elements = [audio_bin, sink]
        audio_bin.sync_state_with_parent()
        sink.sync_state_with_parent()
        # Check both link results explicitly: a silent link failure here
        # (e.g. caps mismatch between our bin's output and what this sink
        # actually accepts) previously surfaced ONLY much later, as a
        # cryptic "not-linked" flow error deep inside webrtcbin once real
        # RTP data arrived -- with zero indication the actual problem was
        # right here.
        link1 = audio_bin.get_static_pad("src").link(sink.get_static_pad("sink"))
        if link1 != Gst.PadLinkReturn.OK:
            log(f"{self.kind}: \u2716 failed to link decode bin to sink "
                f"(caps mismatch?): {link1}")
            emit({"event": "error", "kind": self.kind,
                  "message": f"decode bin -> sink link failed: {link1}"})
            self._teardown_output()
            return
        link2 = pad.link(audio_bin.get_static_pad("sink"))
        if link2 != Gst.PadLinkReturn.OK:
            log(f"{self.kind}: \u2716 failed to link webrtcbin pad to decode bin: {link2}")
            emit({"event": "error", "kind": self.kind,
                  "message": f"webrtcbin pad -> decode bin link failed: {link2}"})
            self._teardown_output()
            return

        label = device.get_display_name() if device else "system default"
        log(f"{self.kind}: routed to native sink ({label}) channel(s) {[c + 1 for c in dest_channels]}")

    def _link_raw_sink(self, pad: Gst.Pad, sink_desc: str,
                        prefix: str = "rtpopusdepay ! opusdec ! audioconvert ! audioresample") -> None:
        bin_desc = f"{prefix} ! {sink_desc}"
        try:
            audio_bin = Gst.parse_bin_from_description(bin_desc, True)
        except GLib.Error as e:
            log(f"[{self.kind}] Failed to build sink bin: {e}")
            emit({"event": "error", "kind": self.kind, "message": f"sink bin error: {e}"})
            return
        self.pipe.add(audio_bin)
        audio_bin.sync_state_with_parent()
        pad.link(audio_bin.get_static_pad("sink"))
        self._output_elements = [audio_bin]

    def _link_sounddevice_router(self, pad: Gst.Pad,
                                  prefix: str = "rtpopusdepay ! opusdec ! audioconvert ! audioresample") -> None:
        bin_desc = (
            f"{prefix} "
            f"! audio/x-raw,format=F32LE,channels={CHANNELS_IN},rate={SAMPLE_RATE},layout=interleaved "
            "! appsink name=sink emit-signals=true sync=false max-buffers=1 drop=true"
        )
        try:
            audio_bin = Gst.parse_bin_from_description(bin_desc, True)
        except GLib.Error as e:
            log(f"[{self.kind}] Failed to build appsink bin: {e}")
            emit({"event": "error", "kind": self.kind, "message": f"appsink bin error: {e}"})
            return
        self.pipe.add(audio_bin)
        audio_bin.sync_state_with_parent()
        # Registered before both the link check and the device-setup
        # try/except below so that if either fails, _teardown_output()
        # actually finds and removes this bin instead of leaking it into
        # the next reconnect attempt.
        self._output_elements = [audio_bin]
        # Check the link result explicitly: this pad is either the webrtcbin's
        # per-pad src (talkback) or the PGM mixer's static src pad, built once
        # at connection startup before any real audio flows through it. A
        # silent failure here previously produced ZERO error output and ZERO
        # audio at the physical device, while every other log line (including
        # "routed to device ..." a few lines below, and the per-slot mixer
        # "active (ssrc match)" log) still printed normally -- there was
        # nothing in the logs pointing at this being the actual break.
        link = pad.link(audio_bin.get_static_pad("sink"))
        if link != Gst.PadLinkReturn.OK:
            log(f"{self.kind}: \u2716 failed to link source pad to appsink bin "
                f"(caps mismatch?): {link}")
            emit({"event": "error", "kind": self.kind,
                  "message": f"source -> appsink link failed: {link}"})
            self._teardown_output()
            return

        device_env = "PGM_OUTPUT_DEVICE" if self.kind == "pgm" else "TALKBACK_OUTPUT_DEVICE"
        ch_env = "PGM_OUTPUT_CH" if self.kind == "pgm" else "TALKBACK_OUTPUT_CH"
        ch_default = "1" if self.kind == "pgm" else "2"
        try:
            dev_idx, dev_info = _resolve_output_device(os.environ.get(device_env, ""))
            dest_channels = _parse_output_channels(os.environ.get(ch_env, ch_default))
            needed = max(dest_channels) + 1
            if needed > dev_info["max_output_channels"]:
                raise RuntimeError(
                    f"channel {needed} requested but device '{dev_info['name']}' only "
                    f"has {dev_info['max_output_channels']} output channels")
            router = OutputDeviceRouter.get_or_create(dev_idx, dev_info["max_output_channels"])
            ring = RingBuffer(seconds=1.0, channels=CHANNELS_IN)
            router.add_channel(self.kind, ring, dest_channels)
            log(f"{self.kind}: routed to device '{dev_info['name']}' (#{dev_idx}) "
                f"channel(s) {[c + 1 for c in dest_channels]}")
        except Exception as e:  # noqa: BLE001
            log(f"{self.kind}: output device setup failed: {e}")
            emit({"event": "error", "kind": self.kind, "message": f"output device error: {e}"})
            self._teardown_output()
            return

        appsink = audio_bin.get_by_name("sink")

        def on_new_sample(sink):
            sample = sink.emit("pull-sample")
            if sample is None:
                return Gst.FlowReturn.OK
            buf = sample.get_buffer()
            ok, mapinfo = buf.map(Gst.MapFlags.READ)
            if ok:
                try:
                    frame = np.frombuffer(mapinfo.data, dtype=np.float32).reshape(-1, CHANNELS_IN)
                    ring.write(frame)
                finally:
                    buf.unmap(mapinfo)
            return Gst.FlowReturn.OK

        appsink.connect("new-sample", on_new_sample)

    def _on_ice_state(self, element, _pspec) -> None:
        state = element.get_property("ice-connection-state")
        state_name = state.value_nick if hasattr(state, "value_nick") else str(state)
        log(f"[{self.kind}] ICE connection state: {state_name}")
        emit({"event": "ice-state", "kind": self.kind, "state": state_name})

    def _on_bus_message(self, _bus, message: Gst.Message) -> None:
        if message.type == Gst.MessageType.ERROR:
            err, dbg = message.parse_error()
            log(f"[{self.kind}] GStreamer ERROR: {err} ({dbg})")
            emit({"event": "error", "kind": self.kind, "message": str(err)})
        elif message.type == Gst.MessageType.EOS:
            log(f"[{self.kind}] End of stream")


# One connection per kind, created lazily on first "start" for that kind.
connections: dict = {}


def _stdin_loop() -> None:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            log(f"Ignoring malformed line: {line!r}")
            continue

        cmd = msg.get("cmd")
        kind = msg.get("kind")

        if cmd == "start":
            if kind not in KINDS:
                log(f"start: invalid/missing kind {kind!r}")
                continue
            try:
                conn = connections.get(kind)
                if conn is None:
                    conn = ReturnAudioConnection(kind)
                    conn.pipe.set_state(Gst.State.PLAYING)
                    connections[kind] = conn
                conn.start(msg["transport"], msg.get("iceServers", []), msg.get("audioPayloadType", 100))
            except Exception as e:  # noqa: BLE001
                log(f"[{kind}] start() failed: {e}")
                emit({"event": "error", "kind": kind, "message": str(e)})
        elif cmd == "stop":
            targets = [connections[kind]] if kind in connections else list(connections.values())
            for conn in targets:
                GLib.idle_add(conn.stop)
        elif cmd == "expect-slot":
            # PGM only: tell the connection which ssrc to expect for `slot` BEFORE
            # publish.js resumes the corresponding mediasoup Consumer, so the
            # eventual pad-added for it can be matched back to this slot.
            conn = connections.get(kind)
            slot = msg.get("slot")
            if kind != "pgm" or conn is None or slot is None:
                continue
            conn.expect_pgm_slot(slot, msg.get("ssrc"))
        elif cmd == "stop-slot":
            # PGM only: one speaker's slot was freed server-side (they stopped
            # talking / disconnected) -- remove just that branch from the mixer.
            conn = connections.get(kind)
            slot = msg.get("slot")
            if kind != "pgm" or conn is None or slot is None:
                continue
            conn.expect_pgm_slot(slot, None)
            GLib.idle_add(conn._teardown_pgm_slot, slot)
        elif cmd == "setVolume":
            conn = connections.get(kind)
            slot = msg.get("slot")
            volume = msg.get("volume")
            if kind != "pgm" or conn is None or slot is None or volume is None:
                continue
            try:
                volume = float(volume)
            except (TypeError, ValueError):
                continue
            GLib.idle_add(conn.set_pgm_slot_volume, slot, volume)
        else:
            log(f"Unknown command: {cmd}")


def main() -> None:
    threading.Thread(target=_stdin_loop, daemon=True).start()

    loop = GLib.MainLoop()
    try:
        loop.run()
    except KeyboardInterrupt:
        pass
    finally:
        for conn in connections.values():
            conn.stop()


if __name__ == "__main__":
    main()
