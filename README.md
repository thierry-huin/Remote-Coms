# Winus Video Server

Low-latency WebRTC video streaming server based on mediasoup.
GStreamer source → mediasoup SFU → WebRTC viewers in browser.

## Architecture

```
PC (GStreamer H.264 RTP) → [PlainTransport] → mediasoup → [WebRTC] → Browsers
```

## Quick Start (local)

```bash
cd /opt/winus-video
bash deploy.sh
```

Opens: `https://localhost:9443`

## Publish Video

Publishing runs exclusively from the installer GUI (`installer/video_publisher.py`) on
the Windows publisher machine — see `installer/setup_windows.bat`. There is no
Linux/CLI publisher in this repo; this Linux server only runs the backend
(`deploy.sh`).

## Ports

| Port | Protocol | Service |
|------|----------|---------|
| 9443 | TCP | HTTPS + WebSocket |
| 9080 | TCP | HTTP redirect |
| 10201-10400 | UDP | mediasoup RTP |
| 3478 | UDP+TCP | TURN/STUN (shared with Winus Intercom) |

> **Note**: Winus Intercom uses ports 8443 (HTTPS) and 10000-10200 (RTP).
> Both services share the same coturn on port 3478.

## Deploy on Proxmox / Remote Server

### Option A: Build + Export (recommended for offline/air-gapped)

On the build machine:
```bash
cd /opt/winus-video
bash build-and-export.sh
# Creates: winus-video-server-YYYYMMDD.HHMM.tar.gz
```

On the target Proxmox LXC/VM:
```bash
cd /tmp
tar xzf winus-video-server-*.tar.gz
cd winus-video-server-*
bash deploy-proxmox.sh
```

### Option B: Direct deploy (requires Docker + Internet)

Copy the project to the target:
```bash
scp -r /opt/winus-video user@host:/opt/winus-video
ssh user@host 'cd /opt/winus-video && bash deploy.sh'
```

### Option C: From Video Control Center

Launch the GUI app:
```bash
cd /opt/winus-video && python3 control_center.py
```
Or double-click `Winus Video Control.sh` on the desktop.

Go to **Deploy** tab → configure SSH → **⬆ Subir proyecto + deploy**.

## Configuration

Edit `.env`:

```env
MEDIASOUP_ANNOUNCED_IPS=51.94.167.240    # Public IP
EXTERNAL_IP=51.94.167.240
LOCAL_IP=10.0.0.5                         # LAN IP
HTTPS_PORT=9443
RTP_MIN_PORT=10201
RTP_MAX_PORT=10400
TURN_HOST=winus.overon.es                 # Shared TURN
```

## GStreamer Publisher Options

Set automatically by `installer/video_publisher.py` when it spawns
`installer/tools/publish.js` — listed here as the env var contract between them.

| Variable | Default | Description |
|----------|---------|-------------|
| `BITRATE` | 4000 | kbps |
| `FPS` | 30 | Frames per second |
| `WIDTH` | 1920 | Resolution width |
| `HEIGHT` | 1080 | Resolution height |
| `DEINTERLACE` | 0 | 1 = enable deinterlace |
| `SOURCE` | videotestsrc | GStreamer source element |
| `DEVICE` | /dev/video0 | Device for v4l2src |
| `KEYFRAME_S` | 2 | Keyframe interval (seconds) |
| `STREAM_ID` | stream-1 | Stream identifier |
| `AUDIO_BITRATE` | 128000 | Opus bitrate (bps) for the main outgoing program audio |

## Return Audio (Mic/PGM + Talkback)

Viewers (comentaristas) can talk back to the publisher of the channel they're watching, in two independent low-latency channels:

- **Mic (PGM)**: program audio (commentary). Meant to be mixed by the publisher into the outgoing feed (SDI/NDI/SRT).
- **Talkback**: private channel to a technician at the publisher. Never mixed into program.

Business rule: turning Talkback ON forces Mic OFF; turning Talkback OFF restores Mic to whatever state it had before.

### Architecture (NAT-safe)

The viewer's mic is produced into mediasoup over its own WebRTC send transport. The
**publisher also consumes it as a plain WebRTC peer** (`tools/return-audio-receiver.py`,
built on GStreamer's `webrtcbin`) instead of receiving raw RTP on a fixed port. This
traverses any NAT/firewall on the publisher's network using the **same TURN server**
already configured for browser viewers (`TURN_HOST`/`TURN_USER`/`TURN_PASSWORD`) —
no port-forwarding or firewall changes are needed on the field PC.

PGM and Talkback each use their **own independent WebRTC connection** (separate
mediasoup `WebRtcTransport`, separate ICE/DTLS session, separate `webrtcbin`
instance) instead of sharing one bundled transport — this avoids ambiguity in
GStreamer when demuxing which incoming RTP stream belongs to which kind.

`tools/publish.js` spawns `return-audio-receiver.py` and drives all WebSocket signaling
per kind (`createReturnTransport`, `connectTransport`, `consumeReturn`, `resumeConsumer`);
the Python process only handles the local WebRTC/GStreamer plumbing (SDP, ICE, DTLS) and
routing the two decoded audio streams to local sinks.

### Requirements on the publisher machine

```bash
sudo apt install gstreamer1.0-plugins-bad gstreamer1.0-nice gir1.2-gst-plugins-bad-1.0
```

On Windows/macOS, `installer/setup_windows.bat` and `installer/setup_mac.command` try to
install these automatically (GStreamer WebRTC plugins + PyGObject). This is best-effort:
if it fails, the installer prints a non-fatal warning and normal video/audio publishing
still works — only Mic/Talkback return audio would be unavailable on that machine.

**macOS: Apple Silicon (ARM) only.** `installer/setup_mac.command` requires an Apple
Silicon Mac (M1/M2/M3/M4) and exits immediately with an explanatory message on Intel
(x86_64) hardware. Apple dropped Intel support entirely starting with macOS 27, and as a
consequence Homebrew (which the installer relies on for `gstreamer`/`pygobject3`/etc.)
stopped building precompiled binaries ("bottles") for Intel — a fresh install on an
Intel Mac would otherwise try to compile everything from source, routinely taking well
over an hour or failing outright.

### Output routing ("Tie-line"): device + channel per return-audio kind

By default, PGM and Talkback are decoded to PCM and routed with `sounddevice`
(PortAudio) to a specific output device and channel pair — not a GStreamer
sink string — the same index/name + `"N-M"` channel convention already used
for audio **input** (`AUDIO_DEVICE`/`AUDIO_CH`, see above). This lets PGM and
Talkback land on distinct channels of the same (or a different) multichannel
interface instead of colliding with the system's default output, which can
otherwise disrupt an unrelated input capture sharing that same device.

In `installer/video_publisher.py`, click the **🔊** button on a channel row to
pick the output device + starting channel for PGM and Talkback independently
(defaults: PGM → channel 1, Talkback → channel 2 of the system default output
— both mono, sharing a single stereo device; use `1-2`/`3-4` style ranges
instead if you have a multichannel interface and want stereo per kind). On
Windows, point these at a VB-Audio VBAN/virtual cable device to bridge
further downstream.

| Variable | Default | Description |
|----------|---------|-------------|
| `RETURN_AUDIO_ENABLED` | 1 | Set to `0` to disable both return channels |
| `PGM_OUTPUT_DEVICE` | (system default) | Output device index or name (substring match) for PGM audio |
| `PGM_OUTPUT_CH` | 1 | Destination channel(s) on that device, e.g. `3-4` for stereo; a single number mixes to mono on that channel |
| `TALKBACK_OUTPUT_DEVICE` | (system default) | Output device index or name for Talkback audio |
| `TALKBACK_OUTPUT_CH` | 2 | Destination channel(s) on that device |
| `PGM_AUDIO_SINK` | (unset) | Advanced escape hatch: if set, bypasses the sounddevice router and uses this raw GStreamer sink string instead (e.g. `autoaudiosink`, `alsasink device=hw:1`) |
| `TALKBACK_AUDIO_SINK` | (unset) | Same escape hatch for Talkback |
| `RETURN_AUDIO_JITTER_MS` | 100 | `webrtcbin`'s internal jitter-buffer latency (ms). Lower = less delay but more glitching on bad networks |
| `RETURN_AUDIO_BUFFER_MS` | 150 | Size of the internal ring buffer bridging GStreamer decode to the sounddevice output callback (ms). Also caps max added latency from clock drift, since the oldest samples are dropped once full |
| `RETURN_AUDIO_WIN_API` | wasapi | Windows only: audio backend for PGM/Talkback output (native GStreamer sink, no sounddevice there — see below). Set to `directsound` if a virtual "audio matrix" driver (e.g. VB-Audio Matrix) resets/invalidates its other open WASAPI streams when this output connects |

If Mic/Talkback feels laggy, these are the two knobs to lower first (try 60/100
for a very tight venue LAN, or raise them back up if you hear crackling/drops
on a congested Wi-Fi/4G link).

Requires `sounddevice`+`numpy` for whichever Python interpreter runs
`tools/return-audio-receiver.py` (on macOS that's `RETURN_AUDIO_PYTHON`, not
the venv — `installer/setup_mac.command` installs both there automatically).
If unavailable, it falls back to `autoaudiosink` with a warning.

## API

- `GET /health` — `{"ok":true,"viewers":N}` (public, no auth)
- `GET /api/stats` — Workers, streams, viewer count (requires `Authorization: Bearer <token>`, any role)
- `GET /api/streams` — Active stream list, incl. `metadata.user` per stream (requires `Authorization: Bearer <token>`, any role -- used by `installer/video_publisher.py`'s channel-occupancy poll)
- `GET /api/streams/:streamId/link` / `POST /api/streams/:streamId/link/regenerate` — Get/rotate a stream's guest link (role `admin`/`superadmin` for any stream; role `publisher` ONLY for a stream it currently owns, see below)
- `POST /api/reset` — Full reset: closes every stream/viewer AND clears the server's channel-ownership locks (role `admin`/`superadmin`)
- WS `forceUnpublish` — Force-close a single stream without affecting any other stream/viewer (role `admin`/`superadmin`; see the admin panel's "🛑 Forzar cierre" button)

### Permissions: viewer / publisher / admin

- **viewer**: watch streams only (no admin panel access at all).
- **publisher** ("streamer"): can see every stream in the admin panel's Streams list, but can only MANAGE (generate/rotate its guest link, adjust PGM volume, private-talk to a commentator, listen to PGM, listen to/disconnect its Talkback/guests) the stream(s) it is CURRENTLY the live owner of -- i.e. the one(s) it started from `installer/video_publisher.py`/`tools/publish.js` with its own login. Ownership is tracked server-side per active stream (see `channelOwners`/`canManageStream` in `backend/src/ws/signaling.js`) and re-checked on every request, so a publisher can never touch another operator's stream even by tampering with the web UI. Force-closing a stream (`forceUnpublish`) stays admin/superadmin-only regardless of ownership.
- **admin**/**superadmin**: full access to every stream plus User Management (create/delete users, Reset Server).

## Sharing domain with Winus Intercom

Both services can run on the same server:

```
winus.overon.es:8443  → Winus Intercom
winus.overon.es:9443  → Winus Video
winus.overon.es:3478  → coturn (shared)
```

Firewall rules needed:
```bash
# Video server
ufw allow 9443/tcp
ufw allow 9080/tcp
ufw allow 10201:10400/udp
```

## Video Control Center

Standalone GUI (`control_center.py`) with two tabs:

- **Server**: Start/Stop/Restart/Rebuild Docker containers, health check
- **Deploy**: Local deploy + remote SSH deploy (user/host/port/key)

Requires: `pip install customtkinter`

## Proxmox Prerequisites

The target Proxmox LXC/VM needs:
- Docker + Docker Compose v2
- Ports opened: 9443/tcp, 9080/tcp, 10201-10400/udp
- (Optional) coturn on port 3478 if not shared with Winus Intercom

The `deploy.sh` script auto-installs Docker if missing, generates `.env` with detected IPs, creates a self-signed certificate, and starts the containers.

## Docker Commands

```bash
docker compose up -d              # Start
docker compose down               # Stop
docker compose logs -f backend    # Logs
docker compose up -d --build backend  # Rebuild backend
docker compose restart backend    # Restart
```
