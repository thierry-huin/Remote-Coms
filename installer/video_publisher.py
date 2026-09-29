#!/usr/bin/env python3
"""Winus Video Publisher — GUI Application.

Detects video/audio sources, configures encoding, and publishes
to a Winus Video Server via GStreamer + WebSocket signaling.
Supports multiple simultaneous streams (up to 8).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import ssl
import sys
import threading
import time
import tkinter as tk
import urllib.request
from pathlib import Path
from tkinter import messagebox

import customtkinter as ctk

SCRIPT_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
CONFIG_FILE = Path.home() / ".config" / "winus-video-publisher.json"

# App version shown in the header (see _build_ui) -- change this one line
# to bump the version, nowhere else.
APP_VERSION = "v1.0"

# Theme
COLOR_BG = "#1a1a2e"
COLOR_CARD = "#16213e"
COLOR_ACCENT = "#7b2ff7"
COLOR_ACCENT2 = "#00c9db"
COLOR_GREEN = "#00e676"
COLOR_RED = "#ff5252"
COLOR_ORANGE = "#ffab40"
COLOR_BLUE = "#2196f3"
COLOR_TEXT = "#e0e0e0"
COLOR_DIM = "#666680"
COLOR_ROW_EVEN = "#1a1a2e"
COLOR_ROW_ODD = "#0f3460"

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("dark-blue")


def load_config() -> dict:
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg: dict):
    try:
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_FILE, "w") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass


# ======================== DEVICE DETECTION ========================

def _probe_dshow_needs_jpegdec(device_name: str) -> bool:
    """Check if a DirectShow device only outputs MJPEG (needs jpegdec)."""
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-f", "dshow", "-list_options", "true",
             "-i", f"video={device_name}"],
            capture_output=True, text=True, timeout=5
        ).stderr
        has_raw = bool(re.search(r'pixel_format=(yuyv422|nv12|uyvy422|yuv420p|bgr24|rgb24|i420)', out, re.I))
        has_mjpeg = bool(re.search(r'(mjpeg|jpeg)', out, re.I))
        return has_mjpeg and not has_raw
    except Exception:
        return False


_NVENC_AVAILABLE_CACHE: bool | None = None


def _windows_nvenc_available() -> bool:
    """Detect once (cached for the life of this process) whether this
    Windows machine's GStreamer install can use NVIDIA NVENC hardware H.264
    encoding (nvh264enc, from the nvcodec plugin) instead of software
    x264enc -- confirmed on real hardware (RTX A1000) to encode 1080p far
    faster than realtime with negligible CPU use, a meaningful win when
    several channels publish simultaneously (x264enc, one instance per
    channel, is otherwise the single biggest CPU consumer in this app).
    Selection actually happens in tools/publish.js (see VIDEO_ENCODER env
    var, set from this in _publish_stream()); this just answers whether
    that GPU path is usable at all on THIS machine. Silently unavailable
    (falls back to x264enc) on any machine without a supported NVIDIA
    GPU/driver/plugin -- same cheap gst-inspect probing pattern already used
    for webrtcbin/decklinkvideosrc elsewhere in this file, so a machine
    without an NVIDIA GPU behaves exactly as before this feature existed.
    """
    global _NVENC_AVAILABLE_CACHE
    if _NVENC_AVAILABLE_CACHE is None:
        try:
            probe = subprocess.run(
                ["gst-inspect-1.0.exe", "nvh264enc"],
                capture_output=True, timeout=3
            )
            _NVENC_AVAILABLE_CACHE = probe.returncode == 0
        except Exception:
            _NVENC_AVAILABLE_CACHE = False
    return _NVENC_AVAILABLE_CACHE


_AMF_AVAILABLE_CACHE: bool | None = None


def _windows_amf_available() -> bool:
    """Detect once (cached for the life of this process) whether this
    Windows machine's GStreamer install can use AMD AMF hardware H.264
    encoding (amfh264enc, from the amfcodec plugin -- gst-plugins-bad
    1.22+) instead of software x264enc -- the AMD counterpart of
    _windows_nvenc_available() above, for machines with an AMD GPU/APU
    (e.g. a Ryzen laptop/mini-PC's integrated Radeon graphics) instead of
    an NVIDIA one. Selection actually happens in tools/publish.js (see
    VIDEO_ENCODER env var, set from this in _publish_stream()); this just
    answers whether that GPU path is usable at all on THIS machine.
    Silently unavailable (falls back to x264enc, or to NVENC if that's
    ALSO present -- see _publish_stream) on any machine without a
    supported AMD GPU/driver/plugin, so a publisher PC without one behaves
    exactly as before this feature existed.
    """
    global _AMF_AVAILABLE_CACHE
    if _AMF_AVAILABLE_CACHE is None:
        try:
            probe = subprocess.run(
                ["gst-inspect-1.0.exe", "amfh264enc"],
                capture_output=True, timeout=3
            )
            _AMF_AVAILABLE_CACHE = probe.returncode == 0
        except Exception:
            _AMF_AVAILABLE_CACHE = False
    return _AMF_AVAILABLE_CACHE


def _detect_windows_decklink_connectors() -> list[dict]:
    """Enumerate Blackmagic Decklink connectors on Windows via
    gst-device-monitor-1.0.exe's persistent-id -- GStreamer's own stable
    per-connector ID (from its suggested "decklinkvideosrc persistent-id=..."
    launch line), NEVER device-number: device-number is a small per-card
    local index (0-3 on a 4-connector card like the Duo 2 Mini) that gets
    reused identically by EVERY card of the same model -- confirmed on real
    hardware with two Duo 2 Mini cards, where probing device-number=0..3
    only ever reached 2 of the 8 real physical connectors, and the ones it
    did reach didn't reliably map to the intended connector (captured the
    wrong/no signal instead of the expected feed). persistent-id has no such
    collision, matching the mfvideosrc device-path approach elsewhere in
    this file for the same reason.

    Shared between video (_detect_windows_video) and audio
    (detect_audio_sources) detection: decklinkvideosrc and decklinkaudiosrc
    address the SAME physical connector via the SAME persistent-id, which
    matters for the native-embedded-audio option (see 'decklink_native:' in
    detect_audio_sources and its handling in tools/publish.js).
    """
    connectors: list[dict] = []
    try:
        inspect = subprocess.run(
            ["gst-inspect-1.0.exe", "decklinkvideosrc"],
            capture_output=True, text=True, timeout=3
        )
        if inspect.returncode != 0:
            return connectors
        out = subprocess.check_output(
            ["gst-device-monitor-1.0.exe", "--include-hidden", "Video/Source"],
            stderr=subprocess.DEVNULL, timeout=5
        ).decode(errors="replace")
        parsed = []
        for block in out.split("Device found:"):
            if "decklinkvideosrc" not in block:
                continue
            display_m = re.search(r'display-name\s*=\s*(.+)', block)
            pid_m = re.search(r'persistent-id\s*=\s*(-?\d+)', block)
            if display_m and pid_m:
                parsed.append((display_m.group(1).strip(), pid_m.group(1).strip()))
        # Two identical cards report the SAME display-name per connector
        # (e.g. both show "DeckLink Duo (1)".."(4)") -- only disambiguate
        # with a "Tarjeta N" suffix when a name is genuinely ambiguous (seen
        # more than once), so a single-card setup keeps the plain,
        # uncluttered name.
        name_counts: dict[str, int] = {}
        for dname, _ in parsed:
            name_counts[dname] = name_counts.get(dname, 0) + 1
        seen_so_far: dict[str, int] = {}
        for dname, pid in parsed:
            if name_counts[dname] > 1:
                seen_so_far[dname] = seen_so_far.get(dname, 0) + 1
                label = f"{dname} (Tarjeta {seen_so_far[dname]})"
            else:
                label = dname
            connectors.append({"persistent_id": pid, "label": label})
    except Exception:
        pass
    return connectors


def _detect_windows_video(sources: list[dict]):
    """Detect video devices on Windows via ffmpeg + Decklink."""
    found = []

    # Method 1: ffmpeg -list_devices (DirectShow devices)
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
            capture_output=True, text=True, timeout=5
        ).stderr
        for m in re.finditer(r'"([^"]+)"\s*\(video\)', out):
            name = m.group(1)
            if name and name not in found:
                found.append(name)
                sources.append({
                    "id": f"dshow:{name}",
                    "name": f"\U0001f4f7 {name}",
                    "gst": f'dshowvideosrc device-name="{name}"',
                    "needs_jpegdec": _probe_dshow_needs_jpegdec(name),
                })
    except Exception:
        pass

    # Media Foundation alternatives (better for some devices, e.g. avoids
    # DirectShow driver quirks) -- matched to their MF device by device-path
    # (GStreamer's own mediafoundation device provider's stable identifier,
    # confirmed via gst-device-monitor-1.0.exe Video/Source), NEVER by
    # reusing the DirectShow list's position as an mfvideosrc device-index:
    # DirectShow and Media Foundation enumerate devices independently and
    # don't share ordering -- confirmed on real hardware where DirectShow's
    # 11th device (index 10) had no corresponding Media Foundation device at
    # all, so mfvideosrc failed to start ("Failed to start" / pipeline
    # doesn't want to preroll).
    try:
        out = subprocess.check_output(
            ["gst-device-monitor-1.0.exe", "Video/Source"],
            stderr=subprocess.DEVNULL, timeout=5
        ).decode(errors="replace")
        for block in out.split("Device found:"):
            if "device.api = mediafoundation" not in block:
                continue
            name_m = re.search(r'^\s*name\s*:\s*(.+)$', block, re.MULTILINE)
            path_m = re.search(r'device\.path\s*=\s*(.+)', block)
            if name_m and path_m:
                mf_name = name_m.group(1).strip()
                mf_path = path_m.group(1).strip()
                sources.append({
                    "id": f"mf:{mf_path}",
                    "name": f"\U0001f3a5 {mf_name} (MF)",
                    "gst": f'mfvideosrc device-path="{mf_path}"',
                })
    except Exception:
        pass

    # Method 2: Decklink/Blackmagic devices (separate GStreamer plugin).
    # Identified by persistent-id -- see _detect_windows_decklink_connectors()
    # docstring for why persistent-id, never device-number, is required.
    connectors = _detect_windows_decklink_connectors()
    for c in connectors:
        sources.append({
            "id": f"decklink:{c['persistent_id']}",
            "name": f"\U0001f3a5 {c['label']}",
            "gst": f"decklinkvideosrc persistent-id={c['persistent_id']} mode=auto connection=auto",
        })
    # If the plugin exists but none could be enumerated by persistent-id
    # (older GStreamer build without that property), fall back to a generic
    # device-number=0 entry as a safety net.
    if not connectors:
        try:
            inspect = subprocess.run(
                ["gst-inspect-1.0.exe", "decklinkvideosrc"],
                capture_output=True, text=True, timeout=3
            )
            if inspect.returncode == 0:
                sources.append({
                    "id": "decklink:0",
                    "name": "\U0001f3a5 Blackmagic Decklink",
                    "gst": "decklinkvideosrc device-number=0 mode=auto connection=auto",
                })
        except Exception:
            pass

    # Method 3: fallback with gst-device-monitor
    if not found:
        try:
            out = subprocess.check_output(
                ["gst-device-monitor-1.0.exe", "Video/Source"],
                stderr=subprocess.DEVNULL, timeout=5
            ).decode()
            for m in re.finditer(r"name\s*:\s*(.+)", out):
                name = m.group(1).strip()
                if name and name not in found:
                    found.append(name)
                    sources.append({
                        "id": f"gst:{name}",
                        "name": f"\U0001f4f7 {name}",
                        "gst": f'dshowvideosrc device-name="{name}"',
                    })
        except Exception:
            pass

    # Method 4: last resort - generic indices
    if not found:
        for i in range(4):
            sources.append({
                "id": f"wincam:{i}",
                "name": f"\U0001f4f7 Camera {i}",
                "gst": f"mfvideosrc device-index={i}",
            })


_AVF_PREFERRED_RESOLUTIONS = [(1920, 1080), (1280, 720), (640, 480), (320, 240)]


def _probe_avfoundation_device(name: str) -> dict | None:
    """Probe a macOS AVFoundation video device (selected by its exact NAME,
    not index -- see detect_video_sources()) for a working
    video_size/framerate/pixel_format combo, without hardcoding any of them.
    Different devices (webcams, OBS Virtual Camera, capture cards) support
    wildly different mode lists, and ffmpeg's avfoundation input errors out
    hard on an unsupported combo instead of auto-negotiating like v4l2/dshow
    do.

    Step 1: deliberately request an absurd framerate. ffmpeg refuses to open
    the device but prints every supported "WxH@[fps fps]fps" mode to stderr
    before failing (confirmed on real hardware). Pick a resolution from a
    priority list of common ones (never "largest available" -- some hardware
    reports non-standard native resolutions, e.g. 2048x1080 on a Blackmagic
    capture card, which would be a bad default here), then the framerate
    closest to 30 for that resolution.

    Step 2: re-probe with that NOW-valid framerate/size. ffmpeg's default
    requested pixel format (yuv420p) is never natively supported by these
    devices, so this also fails but similarly prints the real supported
    pixel-format list first. Picking from that confirmed list up front (nv12
    preferred) avoids a runtime pixel-format mismatch, which would otherwise
    produce corrupted/glitchy video.
    """
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-f", "avfoundation", "-framerate", "9999",
             "-i", f"{name}:none", "-t", "0.01", "-f", "null", "-"],
            capture_output=True, text=True, timeout=6
        ).stderr
    except Exception:
        return None

    modes = re.findall(r'(\d+)x(\d+)@\[([\d.]+)\s+([\d.]+)\]fps', out)
    if not modes:
        return None
    by_res: dict[tuple[int, int], list[float]] = {}
    for w, h, fmin, fmax in modes:
        by_res.setdefault((int(w), int(h)), []).extend([float(fmin), float(fmax)])

    res = next((r for r in _AVF_PREFERRED_RESOLUTIONS if r in by_res), None)
    if res is None:
        res = max(by_res.keys(), key=lambda r: r[0] * r[1])
    fps = min(by_res[res], key=lambda f: abs(f - 30.0))
    fps_str = str(int(round(fps)))
    video_size = f"{res[0]}x{res[1]}"

    pixel_format = "uyvy422"
    try:
        out2 = subprocess.run(
            ["ffmpeg", "-hide_banner", "-f", "avfoundation",
             "-framerate", fps_str, "-video_size", video_size,
             "-i", f"{name}:none", "-t", "0.01", "-f", "null", "-"],
            capture_output=True, text=True, timeout=6
        ).stderr
        pf_idx = out2.find("Supported pixel formats:")
        if pf_idx != -1:
            formats = re.findall(r'\]\s+([a-z0-9]+)\s*$', out2[pf_idx:], re.MULTILINE)
            if formats:
                pixel_format = "nv12" if "nv12" in formats else formats[0]
    except Exception:
        pass

    return {"video_size": video_size, "framerate": fps_str, "pixel_format": pixel_format}


def detect_video_sources() -> list[dict]:
    """Detect available video input devices."""
    sources = [
        {"id": "videotestsrc", "name": "🎥 Test Pattern", "gst": "videotestsrc is-live=true pattern=ball"},
    ]
    seen = set()
    plat = sys.platform

    if plat == "darwin":
        # macOS: avfvideosrc's own device-index is NOT stable -- confirmed on
        # real hardware that the SAME command run back-to-back can open a
        # DIFFERENT physical/virtual camera each time (AVFoundation's own
        # devicesWithMediaType: ordering isn't guaranteed, which is exactly
        # why upstream GStreamer deprecated device-index at 1.30+ in favor of
        # a unique-id property this build doesn't have yet). Other avenues to
        # get a stable identifier were tried and failed on this hardware/
        # GStreamer build: gst-device-monitor-1.0's AVFoundation provider
        # returns nothing at all (known bug), and gst-launch-1.0 -v doesn't
        # print device-name via deep-notify here.
        #
        # ffmpeg's own avfoundation input, however, DOES support selecting a
        # device by its exact NAME string, confirmed stable across repeated
        # runs on real hardware. So cameras are captured via
        # `ffmpeg -f avfoundation -i "<name>:none"` piped into the existing
        # GStreamer H.264/RTP pipeline (see startVideoEncoder() in
        # tools/publish.js) instead of avfvideosrc device-index=N.
        found_names: list[str] = []
        try:
            out = subprocess.run(
                ["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
                capture_output=True, text=True, timeout=6
            ).stderr
            parts = out.split("AVFoundation video devices:", 1)
            if len(parts) == 2:
                video_block = parts[1].split("AVFoundation audio devices:", 1)[0]
                for m in re.finditer(r'\[\d+\]\s+(.+)', video_block):
                    name = m.group(1).strip()
                    # Screen capture is already offered below as a fixed
                    # "screen" entry, and Blackmagic/Decklink capture cards
                    # are already handled via the native decklinkvideosrc
                    # detection further down (better mode/format negotiation
                    # for professional capture hardware than a raw pipe) --
                    # skip both here to avoid duplicate/worse entries.
                    if re.match(r'^Capture screen \d+$', name):
                        continue
                    if "blackmagic" in name.lower():
                        continue
                    if name and name not in found_names:
                        found_names.append(name)
        except Exception:
            pass

        for name in found_names:
            probed = _probe_avfoundation_device(name)
            if not probed:
                continue
            sources.append({
                "id": f"ffmpeg_avf:{name}",
                "name": f"\U0001f4f7 {name}",
                "gst": "ffmpeg_avfoundation",
                "device_name": name,
                "video_size": probed["video_size"],
                "framerate": probed["framerate"],
                "pixel_format": probed["pixel_format"],
            })
            seen.add(name)
        # Last-resort fallback if ffmpeg's device list or every probe failed
        # (e.g. ffmpeg missing/broken): offer plain avfvideosrc numeric
        # indices rather than no camera option at all. This keeps the old,
        # known-unstable behavior only as a safety net, never as the default.
        if not seen:
            for i in range(4):
                sources.append({
                    "id": f"avf:{i}",
                    "name": f"\U0001f4f7 C\u00e1mara AVFoundation #{i} (fallback)",
                    "gst": f"avfvideosrc device-index={i}",
                })
        # Decklink/Blackmagic (UltraStudio, DeckLink, etc.)
        try:
            out = subprocess.check_output(
                ["gst-device-monitor-1.0", "--include-hidden"],
                stderr=subprocess.DEVNULL, timeout=5
            ).decode()
            # Parse device blocks for decklinkvideosrc entries
            for block in out.split("Device found:"):
                if "decklinkvideosrc" in block:
                    name_m = re.search(r'model-name\s*=\s*(.+)', block)
                    launch_m = re.search(r'decklinkvideosrc\s+(\S+)', block)
                    if name_m and launch_m:
                        dname = name_m.group(1).strip()
                        param = launch_m.group(1).strip()
                        sources.append({
                            "id": f"decklink:{dname}",
                            "name": f"🎥 {dname} (Decklink)",
                            "gst": f"decklinkvideosrc {param} mode=auto connection=auto",
                        })
        except Exception:
            pass
        # Fallback: if no Decklink found via monitor, check if plugin exists
        if not any(s["id"].startswith("decklink:") for s in sources):
            try:
                probe = subprocess.run(
                    ["gst-inspect-1.0", "decklinkvideosrc"],
                    capture_output=True, timeout=3
                )
                if probe.returncode == 0:
                    sources.append({
                        "id": "decklink:0",
                        "name": "🎥 Blackmagic Decklink",
                        "gst": "decklinkvideosrc device-number=0 mode=auto connection=auto",
                    })
            except Exception:
                pass
        # Screen capture
        sources.append({
            "id": "screen",
            "name": "🖥 Screen capture",
            "gst": "avfvideosrc capture-screen=true",
        })

    elif plat == "win32":
        # Windows: detect DirectShow video devices via ffmpeg or gst-device-monitor
        _detect_windows_video(sources)
        # Screen capture per monitor
        try:
            import ctypes
            num_monitors = ctypes.windll.user32.GetSystemMetrics(80)  # SM_CMONITORS
        except Exception:
            num_monitors = 1
        for i in range(max(1, num_monitors)):
            label = f"🖥 Screen {i + 1}" if num_monitors > 1 else "🖥 Screen capture"
            sources.append({
                "id": f"screen:{i}",
                "name": label,
                "gst": f"d3d11screencapturesrc monitor-index={i} show-cursor=true",
            })

    else:
        # Linux: V4L2
        try:
            for dev in sorted(Path("/dev").glob("video*")):
                try:
                    out = subprocess.check_output(
                        ["v4l2-ctl", "-d", str(dev), "--info"],
                        stderr=subprocess.DEVNULL, timeout=2
                    ).decode()
                    nm = re.search(r"Card type\s*:\s*(.+)", out)
                    name = nm.group(1).strip() if nm else dev.name
                except Exception:
                    name = dev.name
                sources.append({
                    "id": f"v4l2:{dev}",
                    "name": f"📷 {name} ({dev})",
                    "gst": f"v4l2src device={dev}",
                })
        except Exception:
            pass
        # Decklink
        try:
            out = subprocess.check_output(
                ["gst-device-monitor-1.0", "--include-hidden"],
                stderr=subprocess.DEVNULL, timeout=5
            ).decode()
            for m in re.finditer(r"device\.api\s*=\s*decklink.*?device-name\s*=\s*\"([^\"]+)\"", out, re.DOTALL):
                sources.append({
                    "id": f"decklink:{m.group(1)}",
                    "name": f"🎥 Decklink: {m.group(1)}",
                    "gst": "decklinkvideosrc mode=auto connection=auto",
                })
        except Exception:
            pass
        # Screen capture
        st = os.environ.get("XDG_SESSION_TYPE", "")
        if st == "wayland":
            sources.append({"id": "screen", "name": "🖥 Screen capture (PipeWire)", "gst": "pipewiresrc"})
        else:
            sources.append({"id": "screen", "name": "🖥 Screen capture (X11)", "gst": "ximagesrc use-damage=false show-pointer=true"})

    return sources


def detect_audio_sources() -> list[dict]:
    """Detect available audio input devices."""
    sources = [
        {"id": "none", "name": "🔇 No audio", "gst_source": "none"},
        {"id": "test", "name": "🔊 Test tone", "gst_source": "audiotestsrc"},
    ]

    plat = sys.platform

    if plat == "darwin":
        # macOS: loopback + BlackHole + Blackmagic (via sounddevice pipe)
        sources.append({"id": "osx:loopback", "name": "🔊 Audio Loopback", "gst_source": "osxaudiosrc"})
        # Detect all audio input devices via sounddevice
        found = []
        try:
            import sounddevice as sd
            for i, d in enumerate(sd.query_devices()):
                if d["max_input_channels"] > 0:
                    ch = d["max_input_channels"]
                    found.append({
                        "id": f"sd:{i}",
                        "name": f"🎤 {d['name']} ({ch}ch)",
                        "gst_source": "sounddevice",
                        "max_ch": ch,
                    })
        except Exception:
            pass
        found.sort(key=lambda s: s["name"].lower())
        sources.extend(found)

    elif plat == "win32":
        # Windows: loopback + all DirectShow-visible audio input devices
        sources.append({"id": "wasapi:loopback", "name": "\U0001f50a Audio Loopback", "gst_source": "wasapisrc loopback=true"})
        sources.append({"id": "wasapi:input", "name": "\U0001f3a4 Audio Input (default)", "gst_source": "wasapisrc"})
        # Native Blackmagic Decklink embedded audio -- captured via
        # decklinkaudiosrc sharing the SAME persistent-id as the matching
        # decklinkvideosrc video source (see _detect_windows_decklink_connectors).
        # gst_source is a 'decklink_native:<persistent_id>' marker, NOT a
        # literal GStreamer element string: tools/publish.js special-cases
        # it to capture audio INSIDE the SAME process/pipeline as the video
        # source, never as an independent process. Confirmed on real
        # hardware that Blackmagic's SDK does not allow two separate
        # processes to each open their own native capture session on the
        # same physical connector at once (a second one, even audio-only,
        # errors out immediately with "general stream error"). It ALSO
        # conflicts with the Windows-level WDM "Line In (... Audio)" device
        # for that same connector, listed further below via ffmpeg's dshow
        # audio list: while decklinkvideosrc holds the connector open via
        # the native SDK, that separate WDM path returns real-looking but
        # effectively starved/near-silent audio instead of erroring, which
        # is why it's unreliable for a connector simultaneously used for
        # video and should be preferred only when NOT also capturing video
        # from the same connector (e.g. video from a different source).
        for c in _detect_windows_decklink_connectors():
            sources.append({
                "id": f"decklink_native:{c['persistent_id']}",
                "name": f"\U0001f399 Audio embebido Blackmagic \u2014 {c['label']}",
                "gst_source": f"decklink_native:{c['persistent_id']}",
            })
        # List EVERY DirectShow audio device (ffmpeg), not just VB-Audio/Blackmagic
        # by keyword: any device not matching those keywords (e.g. Dante Virtual
        # Soundcard, or any other audio interface/virtual driver) used to be
        # silently dropped from this list entirely.
        # Cross-reference sounddevice/PortAudio (best-effort, name substring
        # match in both directions) purely to SHOW the real channel count --
        # many Windows virtual drivers (VB-Audio Matrix's VAIO busses, Dante
        # Virtual Soundcard's DVS Transmit/Receive pairs) are each their OWN
        # inherently-stereo device rather than one big multichannel device,
        # so "channel 3-4" silently doesn't exist on them.
        try:
            import sounddevice as sd
            sd_in_devices = [d for d in sd.query_devices() if d["max_input_channels"] > 0]
        except Exception:
            sd_in_devices = []
        found = []
        try:
            out = subprocess.run(
                ["ffmpeg", "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
                capture_output=True, text=True, timeout=5
            ).stderr
            seen_audio = set()
            for m in re.finditer(r'"([^"]+)"\s*\(audio\)', out):
                name = m.group(1)
                if name and name not in seen_audio:
                    seen_audio.add(name)
                    max_ch = None
                    for d in sd_in_devices:
                        if name.lower() in d["name"].lower() or d["name"].lower() in name.lower():
                            max_ch = d["max_input_channels"]
                            break
                    label = f"\U0001f3a4 {name}" + (f" ({max_ch}ch)" if max_ch else "")
                    found.append({
                        "id": f"dshow_audio:{name}",
                        "name": label,
                        "gst_source": "sounddevice",
                        "dshow_name": name,
                        "max_ch": max_ch,
                    })
        except Exception:
            pass
        found.sort(key=lambda s: s["name"].lower())
        sources.extend(found)

    else:
        # Linux: auto + PulseAudio devices
        sources.append({"id": "auto", "name": "🎤 Default", "gst_source": "auto"})
        found = []
        try:
            import sounddevice as sd
            for i, d in enumerate(sd.query_devices()):
                if d["max_input_channels"] > 0:
                    ch = d["max_input_channels"]
                    found.append({
                        "id": f"sd:{i}",
                        "name": f"🎤 {d['name']} ({ch}ch)",
                        "gst_source": f"pulsesrc device={i}",
                        "max_ch": ch,
                    })
        except Exception:
            pass
        found.sort(key=lambda s: s["name"].lower())
        sources.extend(found)

    return sources


def _channels_exceed(ch_str: str, max_ch) -> str | None:
    """Return a human-readable error if ch_str (e.g. "3-4") requests a
    channel beyond max_ch, or None if it's fine / unknown (max_ch falsy
    skips the check rather than false-alarming)."""
    if not max_ch:
        return None
    ch_str = (ch_str or "1-2").replace("-", ",")
    try:
        nums = [int(c.strip()) for c in ch_str.split(",") if c.strip()]
    except ValueError:
        return None
    if not nums:
        return None
    highest = max(nums)
    if highest > max_ch:
        return f"pediste el canal {highest} pero el dispositivo solo tiene {max_ch} canal(es)"
    return None


def _detect_windows_audio_sinks() -> list[dict]:
    """Enumerate Windows audio OUTPUT devices via GStreamer's own device
    monitor (gst-device-monitor-1.0.exe) instead of sounddevice/PortAudio.
    This guarantees the name shown/selected here is EXACTLY what
    tools/return-audio-receiver.py's own Gst.DeviceMonitor resolves at
    runtime: PortAudio and GStreamer's WASAPI/DirectSound providers often
    report slightly different names for the same physical device, which
    silently broke PGM/Talkback output selection for drivers like VB-Audio
    Matrix or Dante Virtual Soundcard (device "not found" even though it
    worked fine).
    """
    devices = []
    seen = set()
    try:
        out = subprocess.check_output(
            ["gst-device-monitor-1.0.exe", "Audio/Sink"],
            stderr=subprocess.DEVNULL, timeout=5
        ).decode(errors="replace")
    except Exception:
        return devices
    for block in out.split("Device found:"):
        name_m = re.search(r"name\s*:\s*(.+)", block)
        if not name_m:
            continue
        name = name_m.group(1).strip()
        if name in seen:
            continue
        seen.add(name)
        # The "properties:" block's device.api is far more reliable across
        # GStreamer versions than trying to parse a suggested gst-launch-1.0
        # command line (not always printed, e.g. not on GStreamer 1.28+ here,
        # which made every device show a useless "(?)" suffix). Omit the
        # parenthetical entirely rather than show a placeholder when unknown.
        api_m = re.search(r"device\.api\s*=\s*(\S+)", block)
        api = api_m.group(1).strip('"').upper() if api_m else ""
        # Real channel count from the device's own caps: many Windows virtual
        # drivers (VB-Audio Matrix VAIO busses, Dante Virtual Soundcard's DVS
        # entries) are each an inherently-stereo device, not one big
        # multichannel device with selectable channel pairs -- surfacing this
        # here lets the "Retorno" dialog warn before publishing instead of
        # silently producing no audio on out-of-range channels. GStreamer
        # prints the "channels" field in several different notations
        # depending on caps shape -- a fixed int (`channels=(int)8` or
        # `channels: 8`), a range (`channels: [ 1, 8 ]`), or a discrete list
        # (`channels: { 2, 4, 6, 8 }`, seen on some VB-Audio Matrix VAIO
        # busses configurable for multiple channel counts). Rather than
        # matching each notation with its own regex (fragile -- a device
        # whose notation isn't covered silently yields no channel count at
        # all, breaking multichannel PGM/Talkback routing), capture just the
        # "channels" field's OWN value (an optional "(int)"-style type
        # annotation, then either a bracketed/braced group or a bare number)
        # and take the MAX integer within it -- bounded so it can't bleed
        # into an unrelated following field (e.g. "rate=(int)48000") the way
        # a fixed-width character window would.
        ch_values = []
        for m in re.finditer(r"channels[=:]", block):
            val_m = re.match(r"\s*(?:\([^)]*\))?\s*(\[[^\]]*\]|\{[^}]*\}|\d+)", block[m.end():])
            if val_m:
                ch_values.extend(int(n) for n in re.findall(r"\d+", val_m.group(1)))
        max_ch = max(ch_values) if ch_values else None
        suffix_parts = [p for p in (api, f"{max_ch}ch" if max_ch else "") if p]
        label = f"\U0001f50a {name}" + (f" ({', '.join(suffix_parts)})" if suffix_parts else "")
        devices.append({
            "id": f"gst:{name}",
            "name": label,
            "index": None,
            "raw_name": name,
            "max_ch": max_ch,
        })
    return devices


# Sentinel entry: picking this for PGM or Talkback means that channel is not
# wired up on this publisher yet. It's included in the SAME device list used
# by both the Mic/PGM and Talkback combos in the "Retorno" dialog, so no
# extra widget is needed. _publish_stream() turns this into
# PGM_ENABLED=0/TALKBACK_ENABLED=0 and stream metadata the viewer uses to
# hide the corresponding button instead of showing one that does nothing.
DISABLED_DEVICE = {"id": "disabled", "name": "\U0001f6ab Deshabilitado (no mostrar al viewer)",
                    "index": None, "raw_name": "", "max_ch": None}


def detect_audio_output_devices() -> list[dict]:
    """Detect available audio OUTPUT devices for routing return audio
    (Mic/PGM, Talkback). On macOS/Linux this uses sounddevice/PortAudio
    directly (no OS branching needed, since we write PCM with sounddevice --
    see tools/return-audio-receiver.py). On Windows, return-audio-receiver.py
    routes natively via GStreamer/WASAPI-DirectSound instead, so device names
    must come from GStreamer's own monitor to resolve reliably at runtime.
    """
    devices = [
        {"id": "", "name": "\U0001f508 Por defecto del sistema", "index": None, "raw_name": ""},
        DISABLED_DEVICE,
    ]
    found = []
    if sys.platform == "win32":
        found = _detect_windows_audio_sinks()
    else:
        try:
            import sounddevice as sd
            for i, d in enumerate(sd.query_devices()):
                if d["max_output_channels"] > 0:
                    found.append({
                        "id": f"sd:{i}",
                        "name": f"\U0001f50a {d['name']} ({d['max_output_channels']}ch)",
                        "index": i,
                        "raw_name": d["name"],
                        "max_ch": d["max_output_channels"],
                    })
        except Exception:
            pass
    found.sort(key=lambda d: d["name"].lower())
    devices.extend(found)
    return devices


# ======================== STREAM ROW ========================

class StreamRow:
    """One row = one publishable stream."""

    def __init__(self, parent: ctk.CTkFrame, index: int, video_sources: list,
                 audio_sources: list = None, output_devices: list = None,
                 on_publish=None, on_stop=None, on_air_toggle=None,
                 on_audio_frame_ms_change=None, on_clock_toggle=None,
                 on_hls_toggle=None):
        self.index = index
        self.process: subprocess.Popen | None = None
        self._on_publish = on_publish
        self._on_stop = on_stop
        self._on_air_toggle = on_air_toggle
        self._on_audio_frame_ms_change = on_audio_frame_ms_change
        self._on_clock_toggle = on_clock_toggle
        self._on_hls_toggle = on_hls_toggle
        self.on_air = False
        self.output_devices = output_devices or [{"id": "", "name": "\U0001f508 Por defecto del sistema", "index": None}]
        default_output_name = self.output_devices[0]["name"]
        self.pgm_output_device_var = tk.StringVar(value=default_output_name)
        self.pgm_output_ch_var = tk.StringVar(value="1")
        self.talkback_output_device_var = tk.StringVar(value=default_output_name)
        self.talkback_output_ch_var = tk.StringVar(value="2")
        # Windows only: native output backend for BOTH PGM and Talkback (one
        # process-wide choice, see RETURN_AUDIO_WIN_API in return-audio-receiver.py).
        # Some virtual "audio matrix" drivers (e.g. VB-Audio Matrix) reset their
        # whole internal engine -- killing the separate main outgoing audio
        # capture -- the instant a WASAPI PGM/Talkback output attaches to any of
        # their ports. DirectSound avoids that reset on those drivers.
        self.return_audio_win_api_var = tk.StringVar(value="wasapi")

        bg = COLOR_ROW_ODD if index % 2 else COLOR_ROW_EVEN
        self.frame = ctk.CTkFrame(parent, fg_color=bg, corner_radius=6)
        self.frame.pack(fill="x", padx=4, pady=3)

        col = 0

        # Stream number
        self.lbl = ctk.CTkLabel(self.frame, text=f"CH {index + 1}",
                                font=("SF Pro Display", 13, "bold"),
                                text_color=COLOR_ACCENT2, width=50)
        self.lbl.grid(row=0, column=col, padx=(8, 4), pady=6)
        col += 1

        # Status LED
        self.status_dot = ctk.CTkLabel(self.frame, text="●", font=("Arial", 24),
                                       text_color=COLOR_DIM, width=30)
        self.status_dot.grid(row=0, column=col, padx=4)
        col += 1

        # Stream name (editable)
        self.name_var = tk.StringVar(value=f"CH {index + 1}")
        self.name_entry = ctk.CTkEntry(self.frame, textvariable=self.name_var,
                                        width=90, height=28, placeholder_text="Name")
        self.name_entry.grid(row=0, column=col, padx=4, pady=4)
        col += 1

        # Video source
        source_names = [s["name"] for s in video_sources]
        self.source_var = tk.StringVar(value=source_names[0] if source_names else "")
        self.source_combo = ctk.CTkComboBox(self.frame, variable=self.source_var,
                                             values=source_names, width=250, height=28,
                                             state="readonly")
        self.source_combo.grid(row=0, column=col, padx=4, pady=4)
        col += 1

        # Bitrate
        self.bitrate_var = tk.StringVar(value="4000")
        self.bitrate_entry = ctk.CTkEntry(self.frame, textvariable=self.bitrate_var,
                                           width=60, height=28, placeholder_text="kbps")
        self.bitrate_entry.grid(row=0, column=col, padx=4, pady=4)
        col += 1

        # Deinterlace
        self.deinterlace_var = tk.BooleanVar(value=False)
        self.deinterlace_cb = ctk.CTkCheckBox(self.frame, text="DI",
                                               variable=self.deinterlace_var, width=40)
        self.deinterlace_cb.grid(row=0, column=col, padx=4, pady=4)
        col += 1

        # HLS (parallel output for WebOS/Smart TV playback, see hls-manager.js
        # on the server side). Unlike DI, this is live-toggleable while
        # already publishing (mirrors the clock-overlay button's IPC style,
        # see _toggle_hls_stream) since it doesn't touch this machine's
        # GStreamer pipeline at all -- the transcode happens server-side.
        self.hls_var = tk.BooleanVar(value=False)
        self.hls_cb = ctk.CTkCheckBox(self.frame, text="HLS",
                                       variable=self.hls_var, width=48,
                                       command=self._toggle_hls)
        self.hls_cb.grid(row=0, column=col, padx=4, pady=4)
        col += 1

        # Stream info: resolution/FPS while publishing, OR (while idle on a
        # channel someone else occupies) that operator's name + stream name
        # + PGM/Talkback availability -- see _update_channel_leds. Wider than
        # before (130->190) so that extra detail doesn't get visually clipped.
        self.info_label = ctk.CTkLabel(self.frame, text="",
                                       font=("SF Pro Display", 10),
                                       text_color=COLOR_ACCENT2, width=190,
                                       anchor="w")
        self.info_label.grid(row=0, column=col, padx=4, pady=4)
        col += 1

        # Audio source
        a_names = [s["name"] for s in (audio_sources or [])]
        self.audio_var = tk.StringVar(value=a_names[0] if a_names else "")
        self.audio_combo = ctk.CTkComboBox(self.frame, variable=self.audio_var,
                                            values=a_names, width=160, height=28,
                                            state="readonly")
        self.audio_combo.grid(row=0, column=col, padx=4, pady=4)
        col += 1

        # Audio channel (e.g. "1-2", "3-4") — used on every OS now that Windows
        # input capture also routes through sounddevice (tools/audio_capture.py)
        # instead of an always-default wasapisrc.
        self.audio_ch_var = tk.StringVar(value="1-2")
        self.audio_ch_entry = ctk.CTkEntry(self.frame, textvariable=self.audio_ch_var,
                                            width=40, height=28, placeholder_text="ch")
        self.audio_ch_entry.grid(row=0, column=col, padx=2, pady=4)
        col += 1

        # Opus bitrate (kbps) for the main outgoing audio (AUDIO_BITRATE in
        # tools/publish.js). Explicit here instead of only a hardcoded
        # default, so it's easy to keep symmetric with the PGM/Talkback
        # return-audio bitrate (also 128kbps by default, see web/viewer.js).
        ctk.CTkLabel(self.frame, text="Op", font=("SF Pro Display", 10),
                     text_color=COLOR_DIM, width=16).grid(row=0, column=col, padx=(4, 0), pady=4)
        col += 1
        self.audio_bitrate_var = tk.StringVar(value="128")
        self.audio_bitrate_combo = ctk.CTkComboBox(
            self.frame, variable=self.audio_bitrate_var,
            values=["64", "96", "128", "160", "192", "256"],
            width=70, height=28, state="readonly")
        self.audio_bitrate_combo.grid(row=0, column=col, padx=(0, 2), pady=4)
        col += 1

        # Audio buffer / Opus frame duration (ms) for the main outgoing audio
        # (AUDIO_FRAME_MS in tools/publish.js). Unlike the other controls,
        # this one stays enabled WHILE publishing and relays a change live to
        # the already-running process over stdin IPC (see
        # VideoPublisherApp._change_audio_frame_ms), same style as On Air.
        ctk.CTkLabel(self.frame, text="Buf", font=("SF Pro Display", 10),
                     text_color=COLOR_DIM, width=22).grid(row=0, column=col, padx=(4, 0), pady=4)
        col += 1
        self.audio_frame_ms_var = tk.StringVar(value="10")
        self.audio_frame_ms_combo = ctk.CTkComboBox(
            self.frame, variable=self.audio_frame_ms_var,
            values=["10", "20", "40", "60"],
            width=70, height=28, state="readonly",
            command=self._on_audio_frame_ms_selected)
        self.audio_frame_ms_combo.grid(row=0, column=col, padx=(0, 2), pady=4)
        col += 1

        # Return audio (Mic/PGM + Talkback) routing — "Tie-line" to a specific output device/channel
        self.return_audio_btn = ctk.CTkButton(self.frame, text="\U0001f50a PGM/TB", width=100, height=28,
                                               font=("SF Pro Display", 11),
                                               fg_color=COLOR_DIM,
                                               command=self._open_return_audio_dialog)
        self.return_audio_btn.grid(row=0, column=col, padx=2, pady=4)
        col += 1

        # Publish button
        self.pub_btn = ctk.CTkButton(self.frame, text="▶", width=40, height=28,
                                      font=("SF Pro Display", 14, "bold"),
                                      fg_color=COLOR_GREEN, hover_color="#00c853",
                                      text_color="#1a1a2e",
                                      command=self._on_click)
        self.pub_btn.grid(row=0, column=col, padx=(4, 8), pady=4)
        col += 1

        # Clock overlay (glass-to-glass latency measurement): a live-toggleable
        # button (not a checkbox, unlike DI) placed right before On Air --
        # "pressed = blue" mirrors the rest of the app's selected-state
        # convention. Works both before publishing (just updates this row's
        # config for the next start) and DURING a live session, where toggling
        # it relays the change over stdin IPC to the already-running
        # publish.js process (see VideoPublisherApp._change_clock_overlay),
        # which restarts just its video encoder -- see startVideoEncoder() in
        # tools/publish.js. A brief video glitch while it restarts is expected.
        self.clock_var = tk.BooleanVar(value=False)
        self.clock_btn = ctk.CTkButton(self.frame, text="⏱", width=32, height=28,
                                        font=("SF Pro Display", 12, "bold"),
                                        fg_color=COLOR_DIM, hover_color="#555568",
                                        command=self._toggle_clock_overlay)
        self.clock_btn.grid(row=0, column=col, padx=(0, 4), pady=4)
        col += 1

        # On Air toggle: tells commentators (guest links) and admins they can
        # start speaking, shown as a red "ON AIR" box top-right on their
        # screen (see web/viewer.js's onair-badge). Only actionable once this
        # row is actually publishing -- relayed live to the already-running
        # publish.js process over stdin (see VideoPublisherApp._toggle_on_air_stream),
        # which forwards it to the server. Can be flipped on/off at any time
        # while live, independent of Mic/PGM/Talkback.
        self.onair_btn = ctk.CTkButton(self.frame, text="\U0001f4e1 On Air", width=72, height=28,
                                        font=("SF Pro Display", 11, "bold"),
                                        fg_color=COLOR_DIM, state="disabled",
                                        command=self._toggle_on_air)
        self.onair_btn.grid(row=0, column=col, padx=(0, 8), pady=4)

    def _toggle_on_air(self):
        if not self.is_publishing:
            return
        self.on_air = not self.on_air
        self._apply_on_air_style()
        if self._on_air_toggle:
            self._on_air_toggle(self, self.on_air)

    def _on_audio_frame_ms_selected(self, value: str):
        if self._on_audio_frame_ms_change:
            self._on_audio_frame_ms_change(self, value)

    def _toggle_hls(self):
        if self._on_hls_toggle:
            self._on_hls_toggle(self, self.hls_var.get())

    def _toggle_clock_overlay(self):
        self.clock_var.set(not self.clock_var.get())
        self._apply_clock_style()
        if self._on_clock_toggle:
            self._on_clock_toggle(self, self.clock_var.get())

    def _apply_clock_style(self):
        if self.clock_var.get():
            self.clock_btn.configure(fg_color=COLOR_BLUE, hover_color="#1976d2", text_color="#ffffff")
        else:
            self.clock_btn.configure(fg_color=COLOR_DIM, hover_color="#555568", text_color=COLOR_TEXT)

    def _apply_on_air_style(self):
        if self.on_air:
            self.onair_btn.configure(fg_color=COLOR_RED, hover_color="#d32f2f", text_color="#ffffff")
        else:
            self.onair_btn.configure(fg_color=COLOR_DIM, hover_color="#555568", text_color=COLOR_TEXT)

    def _open_return_audio_dialog(self):
        """'Tie-line' style routing: pick an output device + channel pair for
        Mic/PGM and Talkback independently, so they can land on distinct
        channels of the same (or different) multichannel interface instead of
        colliding with the system default output."""
        win = ctk.CTkToplevel(self.frame)
        win.title(f"Audio de retorno \u2014 {self.name_var.get()}")
        win.geometry("640x320")
        win.minsize(560, 300)
        win.resizable(True, True)
        win.transient(self.frame.winfo_toplevel())
        win.grab_set()
        win.grid_columnconfigure(1, weight=1)

        names = [d["name"] for d in self.output_devices]

        if sys.platform == "win32":
            ctk.CTkLabel(win, text="API de salida (Windows):").grid(row=0, column=0, sticky="w", padx=14, pady=(14, 0))
            ctk.CTkComboBox(win, variable=self.return_audio_win_api_var,
                             values=["wasapi", "directsound"], width=200,
                             state="readonly").grid(row=0, column=1, sticky="w", padx=14, pady=(14, 0))
            ctk.CTkLabel(win, text="Probá \"directsound\" si el audio principal (de env\u00edo) se corta "
                              "al hablar por PGM/Talkback (algunos drivers tipo VB-Audio Matrix "
                              "resetean su motor interno con WASAPI).",
                         font=("SF Pro Display", 10), text_color=COLOR_DIM,
                         wraplength=560, justify="left"
                         ).grid(row=1, column=0, columnspan=2, sticky="w", padx=14, pady=(0, 8))

        ctk.CTkLabel(win, text="\U0001f399 Mic / PGM", font=("SF Pro Display", 13, "bold")
                     ).grid(row=2, column=0, columnspan=2, sticky="w", padx=14, pady=(14, 4))
        ctk.CTkLabel(win, text="Dispositivo:").grid(row=3, column=0, sticky="w", padx=14)
        ctk.CTkComboBox(win, variable=self.pgm_output_device_var, values=names,
                         width=440, state="readonly").grid(row=3, column=1, sticky="ew", padx=14, pady=4)
        ctk.CTkLabel(win, text="Canal (ej. 1, o 1-2 estéreo):").grid(row=4, column=0, sticky="w", padx=14)
        ctk.CTkEntry(win, textvariable=self.pgm_output_ch_var, width=80
                     ).grid(row=4, column=1, sticky="w", padx=14, pady=4)

        ctk.CTkLabel(win, text="\U0001f4de Talkback", font=("SF Pro Display", 13, "bold")
                     ).grid(row=5, column=0, columnspan=2, sticky="w", padx=14, pady=(18, 4))
        ctk.CTkLabel(win, text="Dispositivo:").grid(row=6, column=0, sticky="w", padx=14)
        ctk.CTkComboBox(win, variable=self.talkback_output_device_var, values=names,
                         width=440, state="readonly").grid(row=6, column=1, sticky="ew", padx=14, pady=4)
        ctk.CTkLabel(win, text="Canal (ej. 2, o 3-4 estéreo):").grid(row=7, column=0, sticky="w", padx=14)
        ctk.CTkEntry(win, textvariable=self.talkback_output_ch_var, width=80
                     ).grid(row=7, column=1, sticky="w", padx=14, pady=4)

        ctk.CTkButton(win, text="Cerrar", command=win.destroy
                      ).grid(row=8, column=0, columnspan=2, pady=18)

    @property
    def is_publishing(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def _on_click(self):
        if self.is_publishing:
            self.stop()
        else:
            self.publish()

    def publish(self):
        if self._on_publish:
            self._on_publish(self)

    def stop(self):
        if self.process:
            import signal
            pid = self.process.pid
            # Kill process tree
            try:
                if sys.platform != "win32":
                    os.killpg(os.getpgid(pid), signal.SIGTERM)
                else:
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                                   capture_output=True)
            except Exception:
                try:
                    self.process.terminate()
                except Exception:
                    pass
            try:
                self.process.wait(timeout=3)
            except Exception:
                try:
                    if sys.platform != "win32":
                        os.killpg(os.getpgid(pid), signal.SIGKILL)
                    else:
                        self.process.kill()
                except Exception:
                    pass
            self.process = None
        self.status_dot.configure(text_color=COLOR_DIM)
        self.pub_btn.configure(text="▶", fg_color=COLOR_GREEN, hover_color="#00c853")
        self.info_label.configure(text="")
        self._set_enabled(True)
        # Stream is gone server-side too (unpublishStream drops the onAir flag
        # along with everything else) -- reset the toggle for next time so it
        # never starts a fresh publish already showing "on air".
        self.on_air = False
        self._apply_on_air_style()
        self.onair_btn.configure(state="disabled")
        if self._on_stop:
            self._on_stop(self)

    def set_publishing(self, proc: subprocess.Popen):
        self.process = proc
        self.status_dot.configure(text_color=COLOR_GREEN)
        self.pub_btn.configure(text="■", fg_color=COLOR_RED, hover_color="#d32f2f")
        self._set_enabled(False)
        self.onair_btn.configure(state="normal")

    def update_info(self, text: str):
        """Update the stream info label (resolution, FPS)."""
        self.info_label.configure(text=text)

    def _set_enabled(self, enabled: bool):
        state = "readonly" if enabled else "disabled"
        # Preserve selections before state change (CTkComboBox bug workaround)
        src = self.source_var.get()
        aud = self.audio_var.get()
        self.source_combo.configure(state=state)
        self.bitrate_entry.configure(state="normal" if enabled else "disabled")
        self.deinterlace_cb.configure(state="normal" if enabled else "disabled")
        self.name_entry.configure(state="normal" if enabled else "disabled")
        self.audio_combo.configure(state=state)
        if self.audio_ch_entry:
            self.audio_ch_entry.configure(state="normal" if enabled else "disabled")
        self.audio_bitrate_combo.configure(state=state)
        # Restore selections after state change
        if src:
            self.source_var.set(src)
        if aud:
            self.audio_var.set(aud)

    def get_config(self) -> dict:
        return {
            "source_name": self.source_var.get(),
            "stream_name": self.name_var.get().strip() or f"CH {self.index + 1}",
            "bitrate": self.bitrate_var.get(),
            "deinterlace": self.deinterlace_var.get(),
            "hls_enabled": self.hls_var.get(),
            "stream_id": f"stream-{self.index + 1}",
            "clock_overlay": self.clock_var.get(),
            "audio_name": self.audio_var.get(),
            "audio_ch": self.audio_ch_var.get().strip() or "1-2",
            "audio_bitrate": self.audio_bitrate_var.get().strip() or "128",
            "audio_frame_ms": self.audio_frame_ms_var.get().strip() or "10",
            "pgm_output_device": self.pgm_output_device_var.get(),
            "pgm_output_ch": self.pgm_output_ch_var.get().strip() or "1",
            "talkback_output_device": self.talkback_output_device_var.get(),
            "talkback_output_ch": self.talkback_output_ch_var.get().strip() or "2",
            "return_audio_win_api": self.return_audio_win_api_var.get() or "wasapi",
        }

    def set_config(self, cfg: dict):
        if cfg.get("source_name"):
            self.source_var.set(cfg["source_name"])
        if cfg.get("stream_name"):
            self.name_var.set(cfg["stream_name"])
        if cfg.get("bitrate"):
            self.bitrate_var.set(cfg["bitrate"])
        self.deinterlace_var.set(cfg.get("deinterlace", False))
        self.hls_var.set(cfg.get("hls_enabled", False))
        self.clock_var.set(cfg.get("clock_overlay", False))
        self._apply_clock_style()
        if cfg.get("audio_name"):
            self.audio_var.set(cfg["audio_name"])
        if cfg.get("audio_ch"):
            self.audio_ch_var.set(cfg["audio_ch"])
        if cfg.get("audio_bitrate"):
            self.audio_bitrate_var.set(cfg["audio_bitrate"])
        if cfg.get("audio_frame_ms"):
            self.audio_frame_ms_var.set(cfg["audio_frame_ms"])
        if cfg.get("pgm_output_device"):
            self.pgm_output_device_var.set(cfg["pgm_output_device"])
        if cfg.get("pgm_output_ch"):
            self.pgm_output_ch_var.set(cfg["pgm_output_ch"])
        if cfg.get("talkback_output_device"):
            self.talkback_output_device_var.set(cfg["talkback_output_device"])
        if cfg.get("talkback_output_ch"):
            self.talkback_output_ch_var.set(cfg["talkback_output_ch"])
        if cfg.get("return_audio_win_api"):
            self.return_audio_win_api_var.set(cfg["return_audio_win_api"])


# ======================== MAIN APP ========================

class VideoPublisherApp:
    NUM_STREAMS = 16
    STREAMS_PER_PAGE = 8

    def __init__(self):
        self.cfg = load_config()
        self.video_sources = detect_video_sources()
        self.audio_sources = detect_audio_sources()
        self.audio_output_devices = detect_audio_output_devices()

        self.root = ctk.CTk()
        self.root.title("Winus Video Publisher")
        self.root.update_idletasks()
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        # Wide enough that every control in a stream row (source, bitrate,
        # audio device/channel, Opus bitrate, PGM/TB, publish button, etc.)
        # is visible without manually resizing the window -- the row's
        # fixed-width widgets add up to well over the previous 900px minimum,
        # which silently clipped the rightmost controls (Retorno/Publish
        # buttons) inside the scrollable frame on first launch.
        # 1420 (was 1360): the info_label column grew 60px (130->190) to fit
        # the occupied-channel detail (user + stream name + PGM/TB) added in
        # _update_channel_leds without clipping.
        w = max(1420, min(int(sw * 0.85), 1800))
        h = max(520, min(int(sh * 0.65), 800))
        x = (sw - w) // 2
        y = max(0, (sh - h) // 2 - 30)
        self.root.geometry(f"{w}x{h}+{x}+{y}")
        self.root.minsize(1420, 480)
        self.root.configure(fg_color=COLOR_BG)

        self.rows: list[StreamRow] = []
        # Cached JWT for the background channel-occupancy poller (see
        # _check_channels) -- logging in fresh on every 5s poll would spam
        # the server (and the log panel), so this is reused until it's
        # rejected (401), at which point it's cleared and re-obtained.
        self._monitor_token: str | None = None
        # Tracks whether the last _check_channels() poll failed (network
        # error, timeout, or repeated login failure) so a transition into/out
        # of that state gets ONE log line each way -- e.g. the Dubai site
        # where nobody could tell why the occupied-channel red LED never lit:
        # every single poll was silently swallowed by `except Exception: pass`
        # below with zero trace in the log panel. Persistent failure (never
        # recovers) still leaves the LEDs simply stale/unlit, but now at
        # least the log panel shows WHY.
        self._channels_check_failing = False
        self._build_ui()
        self._load_saved_config()
        self._start_server_monitor()

    def _build_ui(self):
        # Header
        hdr = ctk.CTkFrame(self.root, fg_color=COLOR_CARD, corner_radius=0, height=50)
        hdr.pack(fill="x")
        hdr.pack_propagate(False)

        logo_path = SCRIPT_DIR / "logo.png"
        if logo_path.exists():
            try:
                from PIL import Image
                img = Image.open(logo_path).resize((32, 32))
                self._logo = ctk.CTkImage(img, size=(32, 32))
                ctk.CTkLabel(hdr, image=self._logo, text="").pack(side="left", padx=(12, 6))
            except ImportError:
                pass

        ctk.CTkLabel(hdr, text="Winus Video Publisher",
                     font=("SF Pro Display", 18, "bold"),
                     text_color=COLOR_TEXT).pack(side="left", padx=4)
        ctk.CTkLabel(hdr, text=APP_VERSION,
                     font=("SF Pro Display", 11),
                     text_color=COLOR_DIM).pack(side="left", padx=8)

        self.status_label = ctk.CTkLabel(hdr, text="",
                                          font=("SF Pro Display", 11),
                                          text_color=COLOR_DIM)
        self.status_label.pack(side="right", padx=16)

        self._logs_visible = True
        self.logs_toggle_btn = ctk.CTkButton(hdr, text="\U0001f5d2 Logs", width=90, height=30,
                                              fg_color=COLOR_DIM, command=self._toggle_logs)
        self.logs_toggle_btn.pack(side="right", padx=4)

        # Server config
        srv = ctk.CTkFrame(self.root, fg_color=COLOR_CARD, corner_radius=8)
        srv.pack(fill="x", padx=10, pady=(8, 4))

        ctk.CTkLabel(srv, text="Server:", font=("SF Pro Display", 12),
                     text_color=COLOR_DIM).pack(side="left", padx=(12, 4))
        self.server_led = ctk.CTkLabel(srv, text="●", font=("Arial", 18),
                                        text_color=COLOR_DIM, width=20)
        self.server_led.pack(side="left", padx=(4, 0))
        self.server_var = tk.StringVar(
            value=self.cfg.get("server", "wss://localhost:9443/ws"))
        self.server_var.trace_add("write", lambda *_: self._schedule_server_check())
        ctk.CTkEntry(srv, textvariable=self.server_var, width=320, height=30
                     ).pack(side="left", padx=4, pady=8)

        # Login fields
        ctk.CTkLabel(srv, text="User:", font=("SF Pro Display", 11),
                     text_color=COLOR_DIM).pack(side="left", padx=(12, 2))
        self.user_var = tk.StringVar(value=self.cfg.get("username", "admin"))
        ctk.CTkEntry(srv, textvariable=self.user_var, width=100, height=30
                     ).pack(side="left", padx=2, pady=8)
        ctk.CTkLabel(srv, text="Pass:", font=("SF Pro Display", 11),
                     text_color=COLOR_DIM).pack(side="left", padx=(8, 2))
        self.pass_var = tk.StringVar()
        ctk.CTkEntry(srv, textvariable=self.pass_var, width=100, height=30, show="•"
                     ).pack(side="left", padx=2, pady=8)

        # GPU (NVENC/AMF) toggle: global, not per-channel (see conversation
        # -- a single machine-wide choice is simpler to reason about than a
        # per-row one, and every channel on the same PC shares the same GPU
        # anyway). Applies to every stream started AFTER it's changed (not
        # live-togglable while already publishing, unlike DI/clock). Default
        # ON the first time this machine's config is saved, ONLY if this
        # GStreamer install can actually use NVENC (see
        # _windows_nvenc_available) -- confirmed on real hardware (RTX
        # A1000) to encode 1080p far faster than realtime with negligible
        # CPU use, a meaningful win with several channels publishing at once
        # (x264enc, one instance per channel, is otherwise the single
        # biggest CPU consumer in this app). Disabled/unclickable on any
        # machine with neither, so a publisher PC without a supported GPU
        # behaves exactly as before these features existed -- see
        # tools/publish.js's VIDEO_ENCODER branch for the actual
        # x264enc/nvh264enc/amfh264enc pipeline swap.
        #
        # AMD AMF (amfh264enc) was FORCED OFF for a while after testing on
        # real hardware (Ryzen 780M iGPU) found streams that browsers
        # couldn't decode (solid black video). That investigation initially
        # suspected the H.264 profile, but with direct SSH access to the
        # Ryzen machine the REAL root cause was found via a raw bitstream
        # capture + a from-scratch Exp-Golomb SPS/NAL parser: the profile
        # was always spec-conformant (High, level 4.2) -- the actual bug was
        # `usage=ultra-low-latency` silently ignoring `gop-size` entirely,
        # so only ONE IDR frame was ever emitted per encoder
        # start/renegotiation. Since this app never sends RTCP PLI to
        # request a fresh keyframe, any viewer that missed that single IDR
        # saw a permanent black screen. Fixed in tools/publish.js's AMF
        # branch by switching to `usage=transcoding` (verified on-hardware:
        # IDR count went from 2/327 frames to 23/327 frames, matching the
        # requested GOP interval, with zero B-frames introduced -- see that
        # file's amf branch comments for the full investigation). AMF is
        # therefore re-enabled here.
        if sys.platform == "win32":
            self._nvenc_available = _windows_nvenc_available()
            self._amf_available = _windows_amf_available()
            gpu_available = self._nvenc_available or self._amf_available
            gpu_label = "NVENC" if self._nvenc_available else "AMF" if self._amf_available else None
            self.use_gpu_var = tk.BooleanVar(
                value=self.cfg.get("use_gpu_encoder", gpu_available) and gpu_available)
            gpu_cb = ctk.CTkCheckBox(
                srv, text=f"\U0001f3ae GPU ({gpu_label})" if gpu_available else "\U0001f3ae GPU (no disponible)",
                variable=self.use_gpu_var, state="normal" if gpu_available else "disabled")
            gpu_cb.pack(side="left", padx=(12, 2), pady=8)
        else:
            self._nvenc_available = False
            self._amf_available = False
            self.use_gpu_var = tk.BooleanVar(value=False)

        # Page selector: up to NUM_STREAMS streams across pages of
        # STREAMS_PER_PAGE each (see _show_page) -- "pressed = blue" mirrors
        # the rest of the app's selected-state convention.
        ctk.CTkLabel(srv, text="P\u00e1g:", font=("SF Pro Display", 11),
                     text_color=COLOR_DIM).pack(side="left", padx=(12, 2))
        self.page_btns: list[ctk.CTkButton] = []
        num_pages = self.NUM_STREAMS // self.STREAMS_PER_PAGE
        for p in range(num_pages):
            btn = ctk.CTkButton(srv, text=str(p + 1), width=30, height=30,
                                 fg_color=COLOR_DIM,
                                 command=lambda p=p: self._show_page(p))
            btn.pack(side="left", padx=2, pady=8)
            self.page_btns.append(btn)

        ctk.CTkButton(srv, text="↻ Devices", width=100, height=30,
                      fg_color=COLOR_ACCENT, command=self._refresh_devices
                      ).pack(side="right", padx=4, pady=8)
        ctk.CTkButton(srv, text="💾 Save", width=80, height=30,
                      fg_color=COLOR_DIM, command=self._save_all
                      ).pack(side="right", padx=4, pady=8)
        ctk.CTkButton(srv, text="■ Stop All", width=100, height=30,
                      fg_color=COLOR_RED, command=self._stop_all
                      ).pack(side="right", padx=4, pady=8)
        # Stream rows
        self.scroll = ctk.CTkScrollableFrame(self.root, fg_color=COLOR_BG)
        self.scroll.pack(fill="both", expand=True, padx=10, pady=4)

        for i in range(self.NUM_STREAMS):
            row = StreamRow(self.scroll, i, self.video_sources,
                           audio_sources=self.audio_sources,
                           output_devices=self.audio_output_devices,
                           on_publish=self._publish_stream,
                           on_stop=self._on_stream_stopped,
                           on_air_toggle=self._toggle_on_air_stream,
                           on_audio_frame_ms_change=self._change_audio_frame_ms,
                           on_clock_toggle=self._change_clock_overlay,
                           on_hls_toggle=self._toggle_hls_stream)
            self.rows.append(row)
        self.current_page = 0
        self._show_page(0)

        # Log
        self.log_text = tk.Text(self.root, bg="#0f0f1e", fg=COLOR_TEXT,
                                 font=("Menlo", 10), wrap="word", height=6,
                                 borderwidth=0, highlightthickness=0)
        self.log_text.pack(fill="x", padx=10, pady=(0, 8))
        self.log_text.configure(state="disabled")
        self.log_text.tag_config("ok", foreground=COLOR_GREEN)
        self.log_text.tag_config("error", foreground=COLOR_RED)
        self.log_text.tag_config("info", foreground=COLOR_ACCENT2)

    def _show_page(self, page: int):
        """Show only the STREAMS_PER_PAGE rows belonging to `page`; the rest
        stay alive (still publishing if they were) but unpacked/hidden.
        _update_status/_stop_all/_save_all/_load_saved_config all iterate
        self.rows directly, so they're unaffected by which page is visible."""
        self.current_page = page
        start = page * self.STREAMS_PER_PAGE
        end = start + self.STREAMS_PER_PAGE
        for i, row in enumerate(self.rows):
            if start <= i < end:
                row.frame.pack(fill="x", padx=4, pady=3)
            else:
                row.frame.pack_forget()
        for i, btn in enumerate(self.page_btns):
            if i == page:
                btn.configure(fg_color=COLOR_BLUE, hover_color="#1976d2", text_color="#ffffff")
            else:
                btn.configure(fg_color=COLOR_DIM, hover_color="#555568", text_color=COLOR_TEXT)

    def _toggle_logs(self):
        """Show/hide the log panel without losing its scrollback."""
        self._logs_visible = not self._logs_visible
        if self._logs_visible:
            self.log_text.pack(fill="x", padx=10, pady=(0, 8))
            self.logs_toggle_btn.configure(fg_color=COLOR_DIM)
        else:
            self.log_text.pack_forget()
            self.logs_toggle_btn.configure(fg_color=COLOR_ACCENT)

    # ── Server status LED ──
    def _schedule_server_check(self):
        """Debounce server check when URL changes."""
        if hasattr(self, "_check_timer"):
            self.root.after_cancel(self._check_timer)
        self._check_timer = self.root.after(800, self._check_server)

    def _check_server(self):
        """Check server health + measure RTT in background thread."""
        url = self.server_var.get().strip()
        if not url:
            self.server_led.configure(text_color=COLOR_DIM)
            return
        # Convert wss://host:port/ws → https://host:port/health
        health_url = url.replace("wss://", "https://").replace("ws://", "http://")
        health_url = health_url.split("/ws")[0] + "/health"

        def _ping():
            try:
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                req = urllib.request.Request(health_url, method="GET")
                t0 = time.monotonic()
                # 6s (was 3s): a 3s timeout on a long-haul/high-latency link
                # (e.g. an operator connecting across continents) could
                # spuriously fail a perfectly healthy check and flash the
                # server LED red for no real reason.
                with urllib.request.urlopen(req, timeout=6, context=ctx) as resp:
                    if resp.status == 200:
                        rtt = int((time.monotonic() - t0) * 1000)
                        self.root.after(0, lambda: self._update_latency(rtt))
                        self.root.after(0, lambda: self.server_led.configure(text_color=COLOR_GREEN))
                        return
            except Exception:
                pass
            self.root.after(0, lambda: self.server_led.configure(text_color=COLOR_RED))

        self.server_led.configure(text_color=COLOR_ORANGE)
        threading.Thread(target=_ping, daemon=True).start()

    def _update_latency(self, rtt_ms: int):
        """Update info labels of publishing rows with latency."""
        for row in self.rows:
            if row.is_publishing:
                caps = getattr(row, '_caps_info', '')
                info = f"{caps} ⏱{rtt_ms}ms" if caps else f"⏱{rtt_ms}ms"
                row.update_info(info)

    def _start_server_monitor(self):
        """Periodically check server status and channel occupancy."""
        self._check_server()
        self._check_channels()
        self.root.after(5000, self._start_server_monitor)

    def _check_channels(self):
        """Check which channels are occupied on the server. /api/streams now
        requires auth (it used to be wide open) -- reuse/obtain a token via
        the same cached-login flow as publishing, see self._monitor_token."""
        url = self.server_var.get().strip()
        if not url:
            return
        api_url = url.replace("wss://", "https://").replace("ws://", "http://")
        api_url = api_url.split("/ws")[0] + "/api/streams"

        def _mark_failing(reason: str):
            # Only log the FIRST failure of a run (not every 5s) to avoid
            # spamming the panel, but always log the moment it starts AND
            # the moment it recovers -- see self._channels_check_failing.
            if not self._channels_check_failing:
                self._channels_check_failing = True
                self.root.after(0, lambda: self.log(
                    f"\u26a0 No se pudo consultar canales ocupados ({reason}); reintentando cada 5s", "error"))

        def _mark_recovered():
            if self._channels_check_failing:
                self._channels_check_failing = False
                self.root.after(0, lambda: self.log("\u2713 Consulta de canales ocupados restablecida", "ok"))

        def _fetch():
            token = self._monitor_token or self._get_auth_token(quiet=True)
            if not token:
                # Covers both "User/Pass still blank" AND a login attempt
                # that itself failed (bad credentials, timeout, server
                # unreachable) -- _get_auth_token(quiet=True) swallows its
                # own log line either way, so this is the only trace left.
                _mark_failing("sin token v\u00e1lido (revisar usuario/contrase\u00f1a o conexi\u00f3n)")
                return  # retry next poll
            self._monitor_token = token
            try:
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                req = urllib.request.Request(api_url, method="GET",
                                              headers={"Authorization": f"Bearer {token}"})
                # 8s (was 3s): the previous timeout was tight enough that a
                # long-haul/high-latency connection (e.g. an operator in
                # Dubai hitting a server on another continent) could
                # legitimately exceed it on every single poll -- silently
                # (see the bare `except Exception: pass` this used to fall
                # into), leaving the occupied-channel red LED permanently
                # unlit with no way to tell why.
                with urllib.request.urlopen(req, timeout=8, context=ctx) as resp:
                    streams = json.loads(resp.read())
                    # Beyond just WHO is using an occupied channel, also carry
                    # its stream name and whether PGM/Talkback are enabled for
                    # it (see the "Retorno" dialog's "Deshabilitado" option in
                    # tools/publish.js's metadata) -- lets an operator see, on
                    # their OWN screen, the settings of a channel someone else
                    # is already running before deciding to touch it.
                    occupied = {}
                    for s in streams:
                        meta = s.get("metadata") or {}
                        occupied[s["streamId"]] = {
                            "user": meta.get("user", "?"),
                            "streamName": s.get("streamName") or s["streamId"],
                            "pgmEnabled": meta.get("pgmEnabled", True),
                            "talkbackEnabled": meta.get("talkbackEnabled", True),
                        }
                    self.root.after(0, lambda: self._update_channel_leds(occupied))
                    _mark_recovered()
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    # Token expired/rejected -- drop it so the next poll logs in again.
                    self._monitor_token = None
                _mark_failing(f"HTTP {e.code}")
            except Exception as e:
                _mark_failing(f"{type(e).__name__}: {e}")

        threading.Thread(target=_fetch, daemon=True).start()

    def _update_channel_leds(self, occupied: dict):
        """Update LED colors: red=occupied by other, green=my stream, dim=free.
        Also shows WHO is using each occupied channel, its stream name, and
        whether PGM/Talkback are enabled for it (see the _fetch() thread in
        _check_channels, which builds `occupied[sid]` as a dict) in the row's
        info label, otherwise blank while idle."""
        for row in self.rows:
            sid = f"stream-{row.index + 1}"
            if row.is_publishing:
                continue  # already green from set_publishing
            if sid in occupied:
                info = occupied[sid]
                row.status_dot.configure(text_color=COLOR_RED)
                row.lbl.configure(text=f"CH {row.index + 1} \u25cf")
                row.pub_btn.configure(state="disabled", fg_color=COLOR_DIM)
                flags = []
                if info.get("pgmEnabled", True):
                    flags.append("PGM")
                if info.get("talkbackEnabled", True):
                    flags.append("TB")
                flags_str = f" [{'/'.join(flags)}]" if flags else " [sin retorno]"
                row.info_label.configure(
                    text=f"\U0001f464 {info['user']} \u00b7 {info['streamName']}{flags_str}")
            else:
                row.status_dot.configure(text_color=COLOR_DIM)
                row.lbl.configure(text=f"CH {row.index + 1}")
                row.pub_btn.configure(state="normal", fg_color=COLOR_GREEN)
                row.info_label.configure(text="")

    def _source_needs_jpegdec(self, source_name: str) -> bool:
        """Check if selected video source needs jpegdec (MJPEG-only device)."""
        for s in self.video_sources:
            if s["name"] == source_name:
                return s.get("needs_jpegdec", False)
        return False

    def _refresh_devices(self):
        self.video_sources = detect_video_sources()
        names = [s["name"] for s in self.video_sources]
        for row in self.rows:
            row.source_combo.configure(values=names)
        self.audio_output_devices = detect_audio_output_devices()
        for row in self.rows:
            row.output_devices = self.audio_output_devices
        self.log(f"✓ {len(self.video_sources)} video sources, "
                 f"{len(self.audio_output_devices)} audio output devices detected", "ok")

    def _get_auth_token(self, quiet: bool = False) -> str | None:
        """Login to server and get JWT token. `quiet=True` (used by the
        background channel-occupancy poller, see _check_channels) skips the
        log lines -- it can legitimately run before the user has filled in
        User/Pass or before the server is reachable, and would otherwise spam
        the log panel every 5 seconds."""
        server = self.server_var.get().strip()
        user = self.user_var.get().strip()
        pw = self.pass_var.get().strip()
        if not user or not pw:
            if not quiet:
                self.log("✖ User/password required", "error")
            return None
        login_url = server.replace("wss://", "https://").replace("ws://", "http://")
        login_url = login_url.split("/ws")[0] + "/api/login"
        try:
            import urllib.request
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            data = json.dumps({"username": user, "password": pw}).encode()
            req = urllib.request.Request(login_url, data=data, method="POST",
                                         headers={"Content-Type": "application/json"})
            # 10s (was 5s): matches the same high-latency tolerance as the
            # health-check and channel-occupancy polls above -- a slow login
            # round-trip shouldn't fail outright on a long-haul connection.
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                result = json.loads(resp.read())
                if not quiet:
                    self.log(f"✓ Login OK ({result.get('role', 'user')})", "ok")
                # Save username
                self.cfg["username"] = user
                save_config(self.cfg)
                return result["token"]
        except urllib.error.HTTPError as e:
            if not quiet:
                self.log(f"✖ Login failed: {e.code} {e.reason}", "error")
        except Exception as e:
            if not quiet:
                self.log(f"✖ Login error: {e}", "error")
        return None

    def _publish_stream(self, row: StreamRow):
        cfg = row.get_config()
        server = self.server_var.get().strip()
        if not server:
            self.log("✖ Server URL is empty", "error")
            return

        # Login first
        token = self._get_auth_token()
        if not token:
            return

        # Find GStreamer source element
        source_name = cfg["source_name"]
        gst_source = None
        video_source_entry = None
        for s in self.video_sources:
            if s["name"] == source_name:
                gst_source = s["gst"]
                video_source_entry = s
                break
        if not gst_source:
            self.log(f"✖ Source not found: {source_name}", "error")
            self.log(f"  Available: {[s['name'] for s in self.video_sources]}", "error")
            return

        publish_js = SCRIPT_DIR / "tools" / "publish.js"
        if not publish_js.exists():
            self.log("✖ tools/publish.js not found", "error")
            return

        # Pass the GStreamer element name; gstreamer-publish.sh adds params per case
        source_element = gst_source.split()[0]
        # GPU (NVENC/AMF) vs software (x264enc) video encoding -- see the
        # global checkbox in _build_ui and tools/publish.js's VIDEO_ENCODER
        # branch. Re-checks availability (not just the checkbox) as a safety
        # net: protects against a stale/forced-on checkbox state (e.g. an
        # old saved config copied from a machine that used to have a GPU)
        # silently trying to build an nvh264enc/amfh264enc pipeline that
        # would just fail. NVENC is preferred over AMF when both are somehow
        # present -- see the checkbox comment in _build_ui.
        use_gpu = self.use_gpu_var.get() and (self._nvenc_available or self._amf_available)
        video_encoder = ("nvenc" if self._nvenc_available else "amf") if use_gpu else "x264"
        self.log(f"  Source: {source_name} → {source_element} (gst: {gst_source}) "
                 f"[{'GPU/' + video_encoder.upper() if use_gpu else 'CPU/x264'}]", "info")

        # Resolve audio source for this channel
        audio_gst = "none"
        audio_device = ""
        audio_dshow_name = ""
        audio_source_entry = None
        audio_name = cfg.get("audio_name", "")
        for a in self.audio_sources:
            if a["name"] == audio_name:
                audio_source_entry = a
                audio_gst = a.get("gst_source", "none")
                # DirectShow-named audio device (Windows): resolved by NAME via
                # tools/audio_capture.py's sounddevice lookup (same mechanism
                # used everywhere else), not a numeric index.
                if a["id"].startswith("dshow_audio:"):
                    audio_dshow_name = a.get("dshow_name", "")
                    audio_device = audio_dshow_name
                    audio_gst = "sounddevice"
                # Sounddevice index (macOS/Linux)
                elif a["id"].startswith("sd:"):
                    audio_device = a["id"].split(":")[1]
                    audio_gst = "sounddevice"
                break

        audio_ch = cfg.get("audio_ch", "1-2")

        # Hard-stop on an out-of-range input channel: many Windows virtual
        # drivers (VB-Audio Matrix VAIO busses, Dante Virtual Soundcard's DVS
        # entries) are each an inherently 2-channel device -- requesting e.g.
        # "3-4" on one of those would make tools/audio_capture.py exit
        # immediately with zero audio, silently breaking the whole stream.
        if audio_gst == "sounddevice":
            ch_err = _channels_exceed(audio_ch, audio_source_entry.get("max_ch") if audio_source_entry else None)
            if ch_err:
                self.log(f"✖ Audio de envío ({audio_name}): {ch_err}. "
                         f"¿Es un bus VAIO/DVS? Usá otro dispositivo (VAIO2, VAIO3, ...) en vez de otro canal.", "error")
                return

        # Return-audio (Mic/PGM + Talkback) output routing — "Tie-line": resolve the
        # chosen device display name back to what tools/return-audio-receiver.py
        # expects (empty string = system default output). On macOS/Linux that's a
        # sounddevice index (PortAudio-based routing); on Windows it's the raw
        # device NAME instead, since return-audio-receiver.py routes natively via
        # GStreamer/WASAPI there (see its _link_gst_native_output for why).
        def _find_output_device(name: str):
            if not name:
                return None
            for d in self.audio_output_devices:
                if d["name"] == name:
                    return d
            # Fallback: the decorated label includes a channel-count/API
            # suffix (e.g. "(WASAPI2, 8ch)") that can change between
            # sessions -- detected channel count in particular has been
            # observed to be unstable for some virtual "audio matrix"
            # drivers -- which broke an EXACT label match against a
            # previously-saved selection, silently disabling PGM/Talkback
            # (hiding the button for viewers) even though the underlying
            # device is still there. Match on the stable raw device name
            # instead, which is always a substring of the old decorated label.
            for d in self.audio_output_devices:
                if d.get("raw_name") and d["raw_name"] in name:
                    return d
            return None

        pgm_device_entry = _find_output_device(cfg.get("pgm_output_device", ""))
        talkback_device_entry = _find_output_device(cfg.get("talkback_output_device", ""))
        # "\U0001f6ab Deshabilitado" (DISABLED_DEVICE) means this channel isn't
        # wired up yet: don't start its WebRTC connection at all, and tell the
        # server (via stream metadata) so the viewer hides that button instead
        # of showing one that silently does nothing.
        pgm_enabled = bool(pgm_device_entry) and pgm_device_entry["id"] != "disabled"
        talkback_enabled = bool(talkback_device_entry) and talkback_device_entry["id"] != "disabled"

        # Require an EXPLICIT output device for PGM/Talkback -- no silent
        # fallback to "Por defecto del sistema". That implicit default has
        # been confirmed to silently collide with the main outgoing audio
        # capture on setups where the system default IS the same virtual
        # device the capture reads from (e.g. VB-Audio Matrix's Out1),
        # producing total, unexplained audio cutouts. Force a conscious
        # device pick (e.g. a distinct VAIO2/VAIO3 bus) instead.
        if pgm_enabled and pgm_device_entry["id"] == "":
            self.log("✖ Mic/PGM: eleg\u00ed un dispositivo expl\u00edcito en \U0001f50a PGM/TB "
                     "(no uses \"Por defecto del sistema\" \u2014 puede coincidir con el "
                     "dispositivo de captura principal y cortar el audio de env\u00edo).", "error")
            return
        if talkback_enabled and talkback_device_entry["id"] == "":
            self.log("✖ Talkback: eleg\u00ed un dispositivo expl\u00edcito en \U0001f50a PGM/TB "
                     "(no uses \"Por defecto del sistema\" \u2014 puede coincidir con el "
                     "dispositivo de captura principal y cortar el audio de env\u00edo).", "error")
            return
        pgm_output_idx = (pgm_device_entry["raw_name"] if sys.platform == "win32" else pgm_device_entry["index"]) \
            if pgm_enabled else None
        talkback_output_idx = (talkback_device_entry["raw_name"] if sys.platform == "win32" else talkback_device_entry["index"]) \
            if talkback_enabled else None

        # Return-audio channel mismatches only WARN (not abort): they only
        # affect the optional Mic/PGM+Talkback feature, not video/main audio.
        pgm_ch_err = _channels_exceed(cfg.get("pgm_output_ch", "1"),
                                       pgm_device_entry.get("max_ch") if pgm_device_entry else None)
        if pgm_ch_err:
            self.log(f"⚠ Mic/PGM ({cfg.get('pgm_output_device', '')}): {pgm_ch_err}. "
                     f"¿Es un bus VAIO/DVS? Usá otro dispositivo en vez de otro canal.", "error")
        talkback_ch_err = _channels_exceed(cfg.get("talkback_output_ch", "2"),
                                            talkback_device_entry.get("max_ch") if talkback_device_entry else None)
        if talkback_ch_err:
            self.log(f"⚠ Talkback ({cfg.get('talkback_output_device', '')}): {talkback_ch_err}. "
                     f"¿Es un bus VAIO/DVS? Usá otro dispositivo en vez de otro canal.", "error")

        env = {
            **os.environ,
            "AUTH_TOKEN": token,
            "SOURCE": source_element,
            "AUDIO_SOURCE": audio_gst,
            "AUDIO_DEVICE": audio_device,
            "AUDIO_DEVICE_NAME": audio_dshow_name,
            "AUDIO_CH": audio_ch,
            "PGM_OUTPUT_DEVICE": str(pgm_output_idx) if pgm_output_idx is not None else "",
            "PGM_OUTPUT_CH": cfg.get("pgm_output_ch", "1"),
            "PGM_OUTPUT_MAX_CH": str(pgm_device_entry.get("max_ch") or "") if pgm_device_entry else "",
            "PGM_ENABLED": "1" if pgm_enabled else "0",
            "TALKBACK_OUTPUT_DEVICE": str(talkback_output_idx) if talkback_output_idx is not None else "",
            "TALKBACK_OUTPUT_CH": cfg.get("talkback_output_ch", "2"),
            "TALKBACK_OUTPUT_MAX_CH": str(talkback_device_entry.get("max_ch") or "") if talkback_device_entry else "",
            "TALKBACK_ENABLED": "1" if talkback_enabled else "0",
            "RETURN_AUDIO_WIN_API": cfg.get("return_audio_win_api", "wasapi"),
            "BITRATE": cfg["bitrate"],
            "AUDIO_BITRATE": str(int(cfg.get("audio_bitrate", "128") or "128") * 1000),
            "AUDIO_FRAME_MS": str(cfg.get("audio_frame_ms", "10") or "10"),
            "FPS": "30",
            "CLOCK_OVERLAY": "1" if cfg.get("clock_overlay") else "0",
            "HLS_ENABLED": "1" if cfg.get("hls_enabled") else "0",
            "VIDEO_NEEDS_JPEGDEC": "1" if self._source_needs_jpegdec(source_name) else "0",
            "DEINTERLACE": "1" if cfg["deinterlace"] else "0",
            "VIDEO_ENCODER": video_encoder,
            "STREAM_ID": cfg["stream_id"],
            "STREAM_NAME": cfg.get("stream_name", cfg["stream_id"]),
            "KEYFRAME_S": "2",
        }

        # Optional override for the Python interpreter running
        # tools/return-audio-receiver.py (Mic/Talkback). On Windows, PyGObject
        # (the "gi" module) is NOT pip-installable for the regular python.org
        # interpreter — it requires an MSYS2 mingw-w64 Python instead. Set
        # "return_audio_python" in %USERPROFILE%\.config\winus-video-publisher.json
        # to that interpreter's full path (e.g. C:\\msys64\\mingw64\\bin\\python3.exe)
        # once it has PyGObject + gst-plugins-bad installed via pacman.
        return_audio_python = self.cfg.get("return_audio_python", "").strip()
        if return_audio_python:
            env["RETURN_AUDIO_PYTHON"] = return_audio_python

        # Pass device info for sources that need it
        if 'persistent-id=' in gst_source:
            m = re.search(r'persistent-id=(\d+)', gst_source)
            if m:
                env["PERSISTENT_ID"] = m.group(1)
        if 'monitor-index=' in gst_source:
            m = re.search(r'monitor-index=(\d+)', gst_source)
            if m:
                env["MONITOR_INDEX"] = m.group(1)
        if 'device-name=' in gst_source:
            m = re.search(r'device-name="([^"]+)"', gst_source)
            if m:
                env["DEVICE_NAME"] = m.group(1)
        elif "device=" in gst_source and "device-index" not in gst_source:
            device = gst_source.split("device=")[1].strip()
            env["DEVICE"] = device
        elif "device-index=" in gst_source:
            idx = gst_source.split("device-index=")[1].strip().split()[0]
            env["DEVICE_INDEX"] = idx
        elif 'device-path=' in gst_source:
            m = re.search(r'device-path="([^"]+)"', gst_source)
            if m:
                env["DEVICE_PATH"] = m.group(1)
        elif gst_source == "ffmpeg_avfoundation" and video_source_entry:
            # macOS camera captured by exact name via ffmpeg (stable, unlike
            # avfvideosrc's device-index) -- see detect_video_sources() and
            # startVideoEncoder()'s ffmpeg_avfoundation branch in publish.js.
            env["DEVICE_NAME"] = video_source_entry.get("device_name", "")
            env["VIDEO_SIZE"] = video_source_entry.get("video_size", "")
            env["VIDEO_FRAMERATE"] = video_source_entry.get("framerate", "")
            env["VIDEO_PIXEL_FORMAT"] = video_source_entry.get("pixel_format", "")

        # Auto-save server URL + this row's current settings (device/channel/API
        # selections, etc.) so they survive an app restart even if the user
        # never pressed the explicit "💾 Save" button.
        self.cfg["server"] = server
        streams_cfg = self.cfg.setdefault("streams", [])
        while len(streams_cfg) <= row.index:
            streams_cfg.append({})
        streams_cfg[row.index] = cfg
        save_config(self.cfg)

        self.log(f"▸ CH{row.index + 1}: Publishing {cfg['stream_id']} "
                 f"({cfg['bitrate']}kbps)", "info")

        proc = subprocess.Popen(
            ["node", str(publish_js), server],
            env=env, cwd=str(SCRIPT_DIR),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            bufsize=1, encoding="utf-8", errors="replace",
            **(dict(preexec_fn=os.setsid) if sys.platform != "win32" else {}),
        )
        row.set_publishing(proc)
        self._update_status()

        # Stream output to log + parse caps for resolution/FPS
        def _reader():
            caps_found = False
            for line in proc.stdout:
                stripped = line.rstrip()
                # Parse GStreamer caps: width, height, framerate
                if not caps_found and 'width=(int)' in stripped:
                    wm = re.search(r'width=\(int\)(\d+)', stripped)
                    hm = re.search(r'height=\(int\)(\d+)', stripped)
                    fm = re.search(r'framerate=\(fraction\)(\d+)/(\d+)', stripped)
                    if wm and hm:
                        w, h = wm.group(1), hm.group(1)
                        info = f"{w}×{h}"
                        if fm:
                            fps_val = int(fm.group(1)) // max(1, int(fm.group(2)))
                            info += f"@{fps_val}"
                        row._caps_info = info
                        self.root.after(0, lambda i=info: row.update_info(i))
                        caps_found = True
                self.root.after(0, lambda l=stripped: self.log(
                    f"[CH{row.index + 1}] {l}", "info"))
            rc = proc.wait()
            self.root.after(0, lambda: self._on_process_exit(row, rc))

        threading.Thread(target=_reader, daemon=True).start()

    def _on_process_exit(self, row: StreamRow, rc: int):
        # NOTE: `row.is_publishing` is ALWAYS False here -- by definition the
        # process already exited (that's why this callback fired), so
        # `self.process.poll()` is never None anymore. Checking it instead of
        # `row.process is not None` used to mean this branch never ran for a
        # spontaneous exit (crash/hang-then-exit): the row was left stuck
        # showing the disabled "publishing" UI (red "■", grayed-out fields)
        # while internally already stopped -- so clicking that stale "■"
        # called publish() instead of stop() (is_publishing was False),
        # silently relaunching with the same settings instead of resetting.
        # `row.process is not None` still skips a redundant stop() when the
        # user already pressed Stop manually (which nulls row.process
        # synchronously before this callback runs).
        if row.process is not None:
            row.stop()
        level = "ok" if rc == 0 else "error"
        self.log(f"CH{row.index + 1}: exited (rc={rc})", level)
        self._update_status()

    def _on_stream_stopped(self, row: StreamRow):
        self._update_status()

    def _toggle_on_air_stream(self, row: StreamRow, on_air: bool):
        """Relay the On Air toggle to the already-running publish.js process
        over its stdin (one JSON object per line, same IPC style used between
        publish.js and return-audio-receiver.py) -- it forwards this to the
        server as 'setOnAir', which broadcasts it to every connected viewer."""
        if not row.process or row.process.poll() is not None or not row.process.stdin:
            return
        try:
            row.process.stdin.write(json.dumps({"cmd": "onair", "value": bool(on_air)}) + "\n")
            row.process.stdin.flush()
            self.log(f"\U0001f4e1 CH{row.index + 1}: On Air {'ON' if on_air else 'OFF'}", "info")
        except Exception as e:
            self.log(f"\u2716 CH{row.index + 1}: no se pudo cambiar On Air: {e}", "error")

    def _change_audio_frame_ms(self, row: StreamRow, value: str):
        """'Buf' control: live-adjust the Opus frame duration (audio buffer)
        of the main outgoing audio. While publishing, relays the new value to
        the already-running publish.js process over its stdin (same IPC
        style as On Air), which restarts just its audio encoder, reusing the
        same locked local RTP port so mediasoup's comedia-mode PlainTransport
        keeps accepting it. When not publishing, the new value is simply kept
        in this row's config (persisted on next Publish/Save) for next start."""
        try:
            frame_ms = float(value)
        except (TypeError, ValueError):
            return
        if not row.is_publishing or not row.process or not row.process.stdin:
            return
        try:
            row.process.stdin.write(json.dumps({"cmd": "setAudioFrameMs", "value": frame_ms}) + "\n")
            row.process.stdin.flush()
            self.log(f"\U0001f50a CH{row.index + 1}: Buffer de audio \u2192 {value}ms", "info")
        except Exception as e:
            self.log(f"\u2716 CH{row.index + 1}: no se pudo cambiar el buffer de audio: {e}", "error")

    def _toggle_hls_stream(self, row: StreamRow, enabled: bool):
        """'HLS' checkbox: enable/disable the parallel HLS output (WebOS/Smart
        TV playback) for this stream. Unlike DI, this is live-toggleable
        while already publishing (same stdin IPC style as On Air/clock
        overlay) -- publish.js just forwards it to the server as
        'setHlsEnabled'; the actual transcode process runs server-side
        (hls-manager.js), so there's nothing to restart on this machine.
        When not publishing, the value is simply kept in this row's config
        (persisted on next Publish/Save) and sent as HLS_ENABLED on next start."""
        if not row.is_publishing or not row.process or not row.process.stdin:
            return
        try:
            row.process.stdin.write(json.dumps({"cmd": "setHls", "value": bool(enabled)}) + "\n")
            row.process.stdin.flush()
            self.log(f"\U0001f4fa CH{row.index + 1}: HLS {'ON' if enabled else 'OFF'}", "info")
        except Exception as e:
            self.log(f"\u2716 CH{row.index + 1}: no se pudo cambiar HLS: {e}", "error")

    def _change_clock_overlay(self, row: StreamRow, enabled: bool):
        """'\u23f1' button: live-adjust the on-video clock overlay (glass-to-glass
        latency reference). While publishing, relays the new value to the
        already-running publish.js process over its stdin (same IPC style as
        On Air/Buf), which restarts just its video encoder, reusing the same
        locked local RTP port so mediasoup's comedia-mode PlainTransport keeps
        accepting it -- a brief video glitch while it restarts is expected.
        When not publishing, the new value is simply kept in this row's
        config (persisted on next Publish/Save) for the next start."""
        if not row.is_publishing or not row.process or not row.process.stdin:
            return
        try:
            row.process.stdin.write(json.dumps({"cmd": "setClockOverlay", "value": bool(enabled)}) + "\n")
            row.process.stdin.flush()
            self.log(f"\u23f1 CH{row.index + 1}: Reloj {'ON' if enabled else 'OFF'}", "info")
        except Exception as e:
            self.log(f"\u2716 CH{row.index + 1}: no se pudo cambiar el reloj: {e}", "error")

    def _stop_all(self):
        for row in self.rows:
            if row.is_publishing:
                row.stop()
        self.log("■ All streams stopped", "info")
        self._update_status()

    def _update_status(self):
        active = sum(1 for r in self.rows if r.is_publishing)
        if active:
            self.status_label.configure(
                text=f"🔴 {active} stream{'s' if active > 1 else ''} live",
                text_color=COLOR_GREEN)
        else:
            self.status_label.configure(text="", text_color=COLOR_DIM)

    def _save_all(self):
        self.cfg["server"] = self.server_var.get().strip()
        self.cfg["use_gpu_encoder"] = self.use_gpu_var.get()
        self.cfg["streams"] = []
        for row in self.rows:
            c = row.get_config()
            self.cfg["streams"].append(c)
        save_config(self.cfg)
        self.log("✓ Config saved", "ok")

    def _load_saved_config(self):
        for i, scfg in enumerate(self.cfg.get("streams", [])):
            if i < len(self.rows):
                self.rows[i].set_config(scfg)

    def log(self, text: str, level: str = "info"):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", text + "\n", level)
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def run(self):
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.mainloop()

    def _on_close(self):
        self._stop_all()
        self.cfg["use_gpu_encoder"] = self.use_gpu_var.get()
        save_config(self.cfg)
        self.root.destroy()


def main():
    app = VideoPublisherApp()
    app.run()


if __name__ == "__main__":
    main()
