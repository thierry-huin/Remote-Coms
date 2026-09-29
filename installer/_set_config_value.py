#!/usr/bin/env python3
"""Set a single top-level key in winus-video-publisher.json without
clobbering other saved settings.

Used by setup_windows.bat to record the MSYS2 Python interpreter path
(RETURN_AUDIO_PYTHON) after auto-installing PyGObject for Mic/Talkback
return audio, since editing JSON safely from batch is impractical.

Usage: python _set_config_value.py <key> <value>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

CONFIG_FILE = Path.home() / ".config" / "winus-video-publisher.json"


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: _set_config_value.py <key> <value>", file=sys.stderr)
        sys.exit(1)
    key, value = sys.argv[1], sys.argv[2]

    try:
        with open(CONFIG_FILE) as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}

    cfg[key] = value

    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"Set {key!r} in {CONFIG_FILE}")


if __name__ == "__main__":
    main()
