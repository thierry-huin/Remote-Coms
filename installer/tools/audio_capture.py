#!/usr/bin/env python3
"""Audio capture — outputs raw PCM to stdout for GStreamer pipe.

Usage:
    python3 audio_capture.py --device 5 --channels 1,2 | gst-launch-1.0 fdsrc fd=0 ! ...

Env (alternative to args):
    AUDIO_DEVICE  - device index or name substring
    AUDIO_CH      - channels, e.g. "1,2" or "1-2" or "3,4"
"""
import sys
import os
import signal
import threading

def main():
    import sounddevice as sd

    # Parse device
    dev_str = os.environ.get("AUDIO_DEVICE", "")
    ch_str = os.environ.get("AUDIO_CH", "1-2")

    for arg in sys.argv[1:]:
        if arg.startswith("--device="):
            dev_str = arg.split("=", 1)[1]
        elif arg.startswith("--channels="):
            ch_str = arg.split("=", 1)[1]

    # Resolve device
    device = None
    if dev_str:
        try:
            device = int(dev_str)
        except ValueError:
            # Search by name
            search = dev_str.lower()
            for i, d in enumerate(sd.query_devices()):
                if search in d["name"].lower() and d["max_input_channels"] > 0:
                    device = i
                    break
            if device is None:
                print(f"Audio device not found: {dev_str}", file=sys.stderr)
                sys.exit(1)

    # Parse channels (1-based to 0-based)
    # Formats: "1,2" or "1-2" or "3,4" or "1"
    ch_str = ch_str.replace("-", ",")
    channels = [int(c.strip()) - 1 for c in ch_str.split(",") if c.strip()]
    if not channels:
        channels = [0, 1]

    num_output_ch = len(channels)
    info = sd.query_devices(device) if device is not None else sd.query_devices(sd.default.device[0])
    dev_channels = info["max_input_channels"]
    dev_name = info["name"]

    # Validate channels
    for c in channels:
        if c >= dev_channels:
            print(f"Channel {c+1} not available on {dev_name} ({dev_channels} channels)", file=sys.stderr)
            sys.exit(1)

    # Open only as many channels as needed to reach the highest one actually
    # requested (e.g. "1-2" -> 2, "3-4" -> 4), NOT the device's full reported
    # channel count. Some virtual "audio matrix" drivers (e.g. VB-Audio
    # Matrix) behave reliably as a plain 2-channel WASAPI client but become
    # unstable once opened with a much higher channel count (e.g. 8) even
    # when only a couple of those channels are actually used -- this mirrors
    # the known-working configuration (2 channels per VAIO bus).
    open_channels = max(channels) + 1

    # Output: FIFO file or stdout
    fifo_path = os.environ.get("AUDIO_FIFO", "")
    out_fd = None

    if fifo_path:
        # Create FIFO if it doesn't exist
        try:
            os.mkfifo(fifo_path)
        except FileExistsError:
            pass
        print(f"[audio_capture] Device: {dev_name} ({dev_channels}ch), ch {[c+1 for c in channels]} -> FIFO {fifo_path}", file=sys.stderr)
        out_fd = open(fifo_path, "wb", buffering=0)
    else:
        print(f"[audio_capture] Device: {dev_name} ({dev_channels}ch), ch {[c+1 for c in channels]} -> stdout", file=sys.stderr)

    # PortAudio reports stream problems (input overflow/underflow, and --
    # critically on Windows/WASAPI -- device invalidation when a virtual
    # "audio matrix" driver resets its internal engine because some OTHER
    # process opened a new stream on one of its ports) via this `status`
    # flag on every callback. It used to be silently discarded, so a driver
    # glitch that cuts the captured audio to silence (without killing this
    # process or raising a Python exception) left zero trace in the logs.
    # Rate-limited to 1/s since a sustained error condition would otherwise
    # log on every single ~20ms callback.
    import time
    _status_state = {"last_log": 0.0}

    def callback(indata, frames, time_info, status):
        if status:
            now = time.monotonic()
            if now - _status_state["last_log"] > 1.0:
                print(f"[audio_capture] \u26a0 stream status: {status}", file=sys.stderr, flush=True)
                _status_state["last_log"] = now
        selected = indata[:, channels]
        try:
            if fifo_path:
                out_fd.write(selected.tobytes())
            else:
                sys.stdout.buffer.write(selected.tobytes())
                sys.stdout.buffer.flush()
        except (BrokenPipeError, OSError):
            os._exit(0)

    def cleanup(*_):
        if fifo_path:
            try:
                out_fd.close()
                os.unlink(fifo_path)
            except Exception:
                pass
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    # Optional (Windows only): open the device in WASAPI EXCLUSIVE mode
    # instead of shared mode. Opt-in via env var since it can fail outright
    # if the device doesn't support the exact rate/format/channel-count
    # combination below in exclusive mode, and no other application can use
    # the device at the same time while it's open. NOTE: confirmed NOT to
    # work with VB-Audio Matrix's virtual VAIO devices (opens without error
    # but produces total silence, since exclusive access apparently blocks
    # the virtual driver's own engine from writing into that port at all).
    extra_settings = None
    if sys.platform == "win32" and os.environ.get("AUDIO_WASAPI_EXCLUSIVE", "0") == "1":
        extra_settings = sd.WasapiSettings(exclusive=True)
        print("[audio_capture] Using WASAPI exclusive mode", file=sys.stderr)

    try:
        with sd.InputStream(
            device=device,
            samplerate=48000,
            blocksize=960,
            channels=open_channels,
            dtype="float32",
            callback=callback,
            extra_settings=extra_settings,
        ):
            print(f"[audio_capture] Streaming... (48kHz, {open_channels}ch opened, "
                  f"{num_output_ch}ch output, float32)", file=sys.stderr)
            try:
                # Block forever until SIGINT/SIGTERM (handled above, calls cleanup()
                # -> sys.exit()). NOT signal.pause() (POSIX-only, doesn't exist on
                # Windows) nor input() (reads stdin, which the parent process spawns
                # with stdio 'ignore' on Windows -- that hits EOF immediately,
                # exiting this script right after it starts and silently producing
                # zero audio). threading.Event().wait() blocks indefinitely on every
                # platform regardless of stdin/signal availability.
                threading.Event().wait()
            except KeyboardInterrupt:
                pass
    except Exception as e:
        # A WASAPI device invalidation (e.g. a virtual "audio matrix" driver
        # resetting its internal engine because some OTHER process opened a
        # new stream on one of its ports) can surface here as a PortAudio
        # exception, silently killing capture with zero explanation unless
        # logged explicitly.
        import traceback
        print(f"[audio_capture] \u2716 InputStream error: {e!r}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        raise
    cleanup()


if __name__ == "__main__":
    main()
