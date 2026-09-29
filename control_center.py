#!/usr/bin/env python3
"""Winus Video — Control Center.

Standalone GUI for managing the video server, publishing streams,
and deploying to remote servers.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import messagebox

import customtkinter as ctk

VIDEO_DIR = Path("/opt/winus-video")
CONFIG_DIR = Path.home() / ".config"
CONFIG_FILE = CONFIG_DIR / "winus-video-control.json"

# Theme (same as Winus Intercom)
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

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("dark-blue")


def load_config() -> dict:
    try:
        with open(CONFIG_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg: dict) -> None:
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_FILE, "w") as f:
            json.dump(cfg, f, indent=2)
    except Exception as e:
        print(f"[config] save error: {e}", file=sys.stderr)


class ShellRunner:
    """Runs shell commands, streaming output to the log panel."""

    def __init__(self, app: "VideoControlCenter"):
        self.app = app
        self.proc: subprocess.Popen | None = None
        self._queue: queue.Queue = queue.Queue()
        self._busy = False

    @property
    def busy(self) -> bool:
        return self._busy

    def run(self, cmd, *, cwd=None, env=None, title="") -> None:
        if self._busy:
            self.app.log("⚠  Ya hay una acción en curso.", level="warn")
            return

        # Handle sudo: inject -S -p '' and feed password via stdin
        feed_stdin = None
        if isinstance(cmd, list) and cmd and cmd[0] == "sudo":
            pw = self.app._sudo_password
            if pw:
                cmd = [cmd[0], "-S", "-p", "", *cmd[1:]]
                feed_stdin = pw + "\n"
            # else: sudo will prompt (might fail in non-interactive)

        self._busy = True
        self.app.set_running(True, title)

        def _worker():
            start = datetime.now()
            label = title or (" ".join(cmd) if isinstance(cmd, list) else cmd)
            self._queue.put(("info", f"\n━━━ ▶ {label}\n"))
            try:
                self.proc = subprocess.Popen(
                    cmd, cwd=cwd, env=env,
                    stdin=subprocess.PIPE if feed_stdin else None,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    bufsize=1, universal_newlines=True,
                )
                if feed_stdin and self.proc.stdin:
                    try:
                        self.proc.stdin.write(feed_stdin)
                        self.proc.stdin.flush()
                        self.proc.stdin.close()
                    except Exception:
                        pass
                for line in self.proc.stdout:
                    self._queue.put(("line", line.rstrip("\n")))
                self.proc.wait()
                rc = self.proc.returncode
            except FileNotFoundError as e:
                self._queue.put(("error", f"✖ Comando no encontrado: {e}"))
                rc = 127
            except Exception as e:
                self._queue.put(("error", f"✖ Error: {e}"))
                rc = 1
            finally:
                elapsed = (datetime.now() - start).total_seconds()
                if rc == 0:
                    self._queue.put(("ok", f"✓ OK (rc=0, {elapsed:.1f}s)"))
                else:
                    self._queue.put(("error", f"✖ Falló (rc={rc}, {elapsed:.1f}s)"))
                self._busy = False
                self.app.root.after(0, lambda: self.app.set_running(False))

        threading.Thread(target=_worker, daemon=True).start()
        self._pump()

    def _pump(self):
        while not self._queue.empty():
            level, text = self._queue.get_nowait()
            self.app.log(text, level=level)
        if self._busy:
            self.app.root.after(100, self._pump)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
            except Exception:
                pass


class VideoControlCenter:
    def __init__(self):
        self.cfg = load_config()
        self.runner = ShellRunner(self)

        self.root = ctk.CTk()
        self.root.title("Winus Video — Control Center")
        # Adapt to screen
        self.root.update_idletasks()
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        w = max(900, min(int(sw * 0.65), 1400))
        h = max(500, min(int(sh * 0.70), 800))
        x = (sw - w) // 2
        y = max(0, (sh - h) // 2 - 30)
        self.root.geometry(f"{w}x{h}+{x}+{y}")
        self.root.minsize(800, 500)
        self.root.configure(fg_color=COLOR_BG)

        self._build_ui()

    def _build_ui(self):
        # Header
        header = ctk.CTkFrame(self.root, fg_color=COLOR_CARD, corner_radius=0, height=50)
        header.pack(fill="x")
        header.pack_propagate(False)
        ctk.CTkLabel(header, text="Winus Video  •  Control Center",
                     font=("SF Pro Display", 18, "bold"),
                     text_color=COLOR_ACCENT2).pack(side="left", padx=16)
        self.status_badge = ctk.CTkLabel(header, text="● idle",
                                          font=("SF Pro Display", 12, "bold"),
                                          text_color=COLOR_DIM)
        self.status_badge.pack(side="right", padx=16)

        # Sudo password (in-memory only)
        sudo_box = ctk.CTkFrame(header, fg_color="transparent")
        sudo_box.pack(side="right", padx=(0, 12))
        ctk.CTkLabel(sudo_box, text="sudo:",
                     font=("SF Pro Display", 11),
                     text_color=COLOR_DIM).pack(side="left", padx=(0, 4))
        self._sudo_password = None
        self.sudo_entry_var = tk.StringVar()
        ctk.CTkEntry(sudo_box, textvariable=self.sudo_entry_var,
                     width=140, height=26, show="•",
                     placeholder_text="contraseña").pack(side="left")
        self.sudo_entry_var.trace_add("write",
            lambda *_: setattr(self, '_sudo_password', self.sudo_entry_var.get() or None))

        # Main split
        body = ctk.CTkFrame(self.root, fg_color=COLOR_BG)
        body.pack(fill="both", expand=True, padx=10, pady=10)
        body.grid_columnconfigure(0, weight=1)
        body.grid_columnconfigure(1, weight=1)
        body.grid_rowconfigure(0, weight=1)

        # Left: tabs
        self.tabview = ctk.CTkTabview(body, fg_color=COLOR_CARD,
                                       segmented_button_selected_color=COLOR_ACCENT)
        self.tabview.grid(row=0, column=0, sticky="nsew", padx=(0, 6))
        self.tabview.add("Server")
        self.tabview.add("Deploy")

        self._build_tab_server(self.tabview.tab("Server"))
        self._build_tab_deploy(self.tabview.tab("Deploy"))

        # Right: log
        log_frame = ctk.CTkFrame(body, fg_color=COLOR_CARD)
        log_frame.grid(row=0, column=1, sticky="nsew", padx=(6, 0))
        log_frame.grid_rowconfigure(1, weight=1)
        log_frame.grid_columnconfigure(0, weight=1)

        log_header = ctk.CTkFrame(log_frame, fg_color="transparent")
        log_header.grid(row=0, column=0, sticky="ew", padx=8, pady=(8, 2))
        ctk.CTkLabel(log_header, text="Logs",
                     font=("SF Pro Display", 13, "bold"),
                     text_color=COLOR_ACCENT2).pack(side="left")
        ctk.CTkButton(log_header, text="Clear", width=60, height=24,
                      fg_color=COLOR_DIM, command=self._clear_log).pack(side="right", padx=4)
        ctk.CTkButton(log_header, text="Stop", width=60, height=24,
                      fg_color=COLOR_RED, command=self.runner.stop).pack(side="right", padx=4)

        self.log_text = tk.Text(log_frame, bg="#0f0f1e", fg=COLOR_TEXT,
                                 font=("Menlo", 11), wrap="word",
                                 borderwidth=0, highlightthickness=0)
        self.log_text.grid(row=1, column=0, sticky="nsew", padx=8, pady=(0, 8))
        sb = ctk.CTkScrollbar(log_frame, command=self.log_text.yview)
        sb.grid(row=1, column=1, sticky="ns", pady=(0, 8))
        self.log_text.configure(yscrollcommand=sb.set, state="disabled")
        for tag, color in [("info", COLOR_ACCENT2), ("ok", COLOR_GREEN),
                           ("warn", COLOR_ORANGE), ("error", COLOR_RED), ("line", COLOR_TEXT)]:
            self.log_text.tag_config(tag, foreground=color)

    # ── TAB: SERVER ──
    def _build_tab_server(self, parent):
        ctk.CTkLabel(parent, text="Docker — Winus Video Server",
                     font=("SF Pro Display", 14, "bold"),
                     text_color=COLOR_ACCENT2).pack(anchor="w", padx=14, pady=(12, 6))

        def vdc(*args, title=""):
            compose = VIDEO_DIR / "docker-compose.yml"
            if not compose.exists():
                self.log(f"✖ No existe {compose}", level="error")
                return
            cmd = ["sudo", "docker", "compose", "-f", str(compose), *args]
            self.runner.run(cmd, cwd=str(VIDEO_DIR), title=title)

        specs = [
            ("▶ Start", COLOR_GREEN, "#1a1a2e",
             lambda: vdc("up", "-d", title="video: start")),
            ("■ Stop", COLOR_RED, None,
             lambda: vdc("down", title="video: stop")),
            ("⟳ Restart", COLOR_BLUE, None,
             lambda: vdc("restart", title="video: restart")),
            ("🔨 Rebuild backend", COLOR_ACCENT, None,
             lambda: vdc("up", "-d", "--build", "backend", title="video: rebuild")),
            ("📝 Logs backend", COLOR_DIM, None,
             lambda: vdc("logs", "--tail=80", "backend", title="video: logs")),
            ("📝 Logs nginx", COLOR_DIM, None,
             lambda: vdc("logs", "--tail=80", "nginx", title="video: nginx logs")),
        ]
        for label, color, text_color, cmd in specs:
            ctk.CTkButton(parent, text=label, width=300, height=32,
                          fg_color=color, text_color=text_color or COLOR_TEXT,
                          anchor="w", command=cmd
                          ).pack(padx=14, pady=2)

        # Health check
        ctk.CTkLabel(parent, text="Estado",
                     font=("SF Pro Display", 12),
                     text_color=COLOR_DIM).pack(anchor="w", padx=14, pady=(14, 2))
        ctk.CTkButton(parent, text="🩺 Health check", width=300, height=32,
                      fg_color=COLOR_ACCENT2, text_color="#1a1a2e",
                      anchor="w", command=self._health_check
                      ).pack(padx=14, pady=2)

    def _health_check(self):
        def _run():
            try:
                import urllib.request
                import ssl
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                url = "https://localhost:9443/health"
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, context=ctx, timeout=5) as resp:
                    data = resp.read().decode()
                self.root.after(0, lambda: self.log(f"✓ {url} → {data}", level="ok"))
            except Exception as e:
                self.root.after(0, lambda: self.log(f"✖ Health check failed: {e}", level="error"))
        threading.Thread(target=_run, daemon=True).start()

    # ── TAB: DEPLOY ──
    def _build_tab_deploy(self, parent):
        ctk.CTkLabel(parent, text="Deploy local",
                     font=("SF Pro Display", 14, "bold"),
                     text_color=COLOR_ACCENT2).pack(anchor="w", padx=14, pady=(12, 4))

        local_specs = [
            ("🩺 Deploy local (deploy.sh)", COLOR_GREEN, "#1a1a2e",
             lambda: self.runner.run(
                 ["bash", str(VIDEO_DIR / "deploy.sh")],
                 cwd=str(VIDEO_DIR), title="deploy.sh")),
            ("🔨 Rebuild backend local", COLOR_BLUE, None,
             lambda: self.runner.run(
                 ["sudo", "docker", "compose", "-f",
                  str(VIDEO_DIR / "docker-compose.yml"),
                  "up", "-d", "--build", "backend"],
                 cwd=str(VIDEO_DIR), title="rebuild backend")),
            ("📦 Export Proxmox (tar.gz)", COLOR_ACCENT, None,
             lambda: self.runner.run(
                 ["bash", str(VIDEO_DIR / "build-and-export.sh")],
                 cwd=str(VIDEO_DIR), title="build-and-export.sh")),
        ]
        for label, color, text_color, cmd in local_specs:
            ctk.CTkButton(parent, text=label, width=340, height=32,
                          fg_color=color, text_color=text_color or COLOR_TEXT,
                          anchor="w", command=cmd
                          ).pack(padx=14, pady=2)

        # Remote deploy
        ctk.CTkLabel(parent, text="Deploy remoto (SSH)",
                     font=("SF Pro Display", 14, "bold"),
                     text_color=COLOR_ACCENT2).pack(anchor="w", padx=14, pady=(14, 4))

        form = ctk.CTkFrame(parent, fg_color="transparent")
        form.pack(fill="x", padx=14, pady=2)

        ctk.CTkLabel(form, text="Usuario:").grid(row=0, column=0, sticky="w", pady=2)
        self.deploy_user_var = tk.StringVar(value=self.cfg.get("deploy_user", "ubuntu"))
        ctk.CTkEntry(form, textvariable=self.deploy_user_var, width=120, height=26
                     ).grid(row=0, column=1, padx=4, pady=2)

        ctk.CTkLabel(form, text="Host:").grid(row=0, column=2, sticky="w", padx=(8, 0), pady=2)
        self.deploy_host_var = tk.StringVar(value=self.cfg.get("deploy_host", ""))
        ctk.CTkEntry(form, textvariable=self.deploy_host_var, width=200, height=26,
                     placeholder_text="winus.overon.es"
                     ).grid(row=0, column=3, padx=4, pady=2)

        ctk.CTkLabel(form, text="Port:").grid(row=0, column=4, sticky="w", padx=(8, 0), pady=2)
        self.deploy_port_var = tk.StringVar(value=self.cfg.get("deploy_port", "22"))
        ctk.CTkEntry(form, textvariable=self.deploy_port_var, width=50, height=26
                     ).grid(row=0, column=5, padx=4, pady=2)

        ctk.CTkLabel(form, text="Key:").grid(row=1, column=0, sticky="w", pady=2)
        self.deploy_key_var = tk.StringVar(value=self.cfg.get("deploy_key", ""))
        ctk.CTkEntry(form, textvariable=self.deploy_key_var, width=340, height=26,
                     placeholder_text="~/.ssh/id_ed25519 (dejar vacío para password)"
                     ).grid(row=1, column=1, columnspan=5, padx=4, pady=2, sticky="w")

        ctk.CTkLabel(form, text="Password:").grid(row=2, column=0, sticky="w", pady=2)
        self.deploy_pass_var = tk.StringVar()
        ctk.CTkEntry(form, textvariable=self.deploy_pass_var, width=200, height=26,
                     show="•", placeholder_text="solo si no usas key (no se guarda)"
                     ).grid(row=2, column=1, columnspan=3, padx=4, pady=2, sticky="w")

        ctk.CTkButton(form, text="💾 Guardar", width=90, height=26,
                      fg_color=COLOR_DIM,
                      command=self._save_deploy_cfg
                      ).grid(row=0, column=6, padx=(8, 0))

        remote_specs = [
            ("🧪 Probar SSH", COLOR_DIM, None, self._deploy_test_ssh),
            ("⬆ Subir proyecto + deploy", COLOR_GREEN, "#1a1a2e", self._deploy_remote_full),
            ("🔨 Rebuild backend remoto", COLOR_ACCENT, None, self._deploy_remote_rebuild),
            ("🔄 Reload nginx remoto", COLOR_ORANGE, None, self._deploy_remote_reload_nginx),
            ("📝 Logs remotos", COLOR_BLUE, None, self._deploy_remote_logs),
        ]
        for label, color, text_color, cmd in remote_specs:
            ctk.CTkButton(parent, text=label, width=340, height=32,
                          fg_color=color, text_color=text_color or COLOR_TEXT,
                          anchor="w", command=cmd
                          ).pack(padx=14, pady=2)

    def _ssh_target(self) -> str:
        return f"{self.deploy_user_var.get().strip()}@{self.deploy_host_var.get().strip()}"

    def _ssh_args(self) -> list[str]:
        args = ["-o", "StrictHostKeyChecking=accept-new"]
        port = self.deploy_port_var.get().strip()
        if port and port != "22":
            args += ["-p", port]
        key = self.deploy_key_var.get().strip()
        if key:
            args += ["-i", os.path.expanduser(key)]
        return args

    def _scp_args(self) -> list[str]:
        args = ["-o", "StrictHostKeyChecking=accept-new", "-r"]
        port = self.deploy_port_var.get().strip()
        if port and port != "22":
            args += ["-P", port]
        key = self.deploy_key_var.get().strip()
        if key:
            args += ["-i", os.path.expanduser(key)]
        return args

    def _save_deploy_cfg(self):
        self.cfg["deploy_user"] = self.deploy_user_var.get().strip()
        self.cfg["deploy_host"] = self.deploy_host_var.get().strip()
        self.cfg["deploy_port"] = self.deploy_port_var.get().strip()
        self.cfg["deploy_key"] = self.deploy_key_var.get().strip()
        save_config(self.cfg)
        self.log("✓ Deploy SSH config guardada", level="ok")

    def _use_ssh_password(self) -> bool:
        return bool(self.deploy_pass_var.get().strip())

    def _sudo_cmd(self, cmd: str) -> str:
        """Wrap a remote command so ALL sudo calls get the password via -S."""
        if not self._use_ssh_password():
            return cmd
        pw = self.deploy_pass_var.get()
        safe_pw = pw.replace("'", "'\\''")
        # Replace every 'sudo ' with password-piped version
        return cmd.replace("sudo ", f"printf '%s\\n' '{safe_pw}' | sudo -S -p '' ")

    def _wrap_sshpass(self, cmd: list[str]) -> tuple[list[str], dict | None]:
        """Prepend sshpass -e if password auth is configured."""
        if not self._use_ssh_password():
            return cmd, None
        import shutil
        if shutil.which("sshpass") is None:
            self.log("✖ sshpass no instalado. sudo apt install -y sshpass", level="error")
            return cmd, None
        env = {**os.environ, "SSHPASS": self.deploy_pass_var.get()}
        return ["sshpass", "-e", *cmd], env

    def _deploy_test_ssh(self):
        target = self._ssh_target()
        if not self.deploy_host_var.get().strip():
            self.log("✖ Rellena el Host", level="error")
            return
        extra = [] if self._use_ssh_password() else ["-o", "BatchMode=yes"]
        cmd = ["ssh", *self._ssh_args(), *extra, "-o", "ConnectTimeout=5",
               target, "echo OK && hostname && uptime"]
        cmd, env = self._wrap_sshpass(cmd)
        self.runner.run(cmd, env=env, title=f"ssh {target} (test)")

    def _deploy_remote_full(self):
        target = self._ssh_target()
        if not self.deploy_host_var.get().strip():
            self.log("✖ Rellena el Host", level="error")
            return
        # Create remote dir first
        mkdir_cmd = self._sudo_cmd("sudo mkdir -p /opt/winus-video && sudo chown $(whoami) /opt/winus-video")
        pre_cmd = ["ssh", *self._ssh_args(), target, mkdir_cmd]
        pre_cmd, pre_env = self._wrap_sshpass(pre_cmd)
        self.runner.run(pre_cmd, env=pre_env, title=f"mkdir {target}:/opt/winus-video")
        # Chain SCP after mkdir
        self.root.after(500, lambda: self._deploy_scp_chain(target))

    def _deploy_scp_chain(self, target: str):
        if self.runner.busy:
            self.root.after(500, lambda: self._deploy_scp_chain(target))
            return
        self.log(f"▸ Subiendo archivos → {target}:/opt/winus-video/", level="info")
        cmd = ["scp", *self._scp_args(),
               str(VIDEO_DIR / "backend"), str(VIDEO_DIR / "web"),
               str(VIDEO_DIR / "tools"), str(VIDEO_DIR / "nginx"),
               str(VIDEO_DIR / "coturn"),
               str(VIDEO_DIR / "docker-compose.yml"),
               str(VIDEO_DIR / ".env.template"),
               str(VIDEO_DIR / "deploy.sh"),
               f"{target}:/opt/winus-video/"]
        cmd, env = self._wrap_sshpass(cmd)
        self.runner.run(cmd, env=env, title=f"scp → {target}")
        # Chain deploy.sh after SCP
        self.root.after(500, lambda: self._deploy_after_scp(target))

    def _deploy_after_scp(self, target: str):
        if self.runner.busy:
            self.root.after(500, lambda: self._deploy_after_scp(target))
            return
        self.log(f"▸ Ejecutando deploy.sh en {target}...", level="info")
        self._deploy_remote_rebuild()

    def _deploy_remote_rebuild(self):
        target = self._ssh_target()
        if not self.deploy_host_var.get().strip():
            self.log("✖ Rellena el Host", level="error")
            return
        remote_cmd = self._sudo_cmd("cd /opt/winus-video && sudo bash deploy.sh")
        cmd = ["ssh", *self._ssh_args(), target, remote_cmd]
        cmd, env = self._wrap_sshpass(cmd)
        self.runner.run(cmd, env=env, title=f"remote rebuild {target}")

    def _deploy_remote_reload_nginx(self):
        """Restart the nginx container so it picks up a new nginx.conf /
        web/ bind-mount without a full backend rebuild. `docker compose
        up -d --build` (used by deploy.sh) does NOT do this on its own:
        nginx.conf and web/ are bind-mounted read-only, and compose only
        recreates a container when its *service definition* changes, not
        when the content of a mounted file changes."""
        target = self._ssh_target()
        if not self.deploy_host_var.get().strip():
            self.log("✖ Rellena el Host", level="error")
            return
        remote_cmd = self._sudo_cmd("cd /opt/winus-video && sudo docker compose restart nginx")
        cmd = ["ssh", *self._ssh_args(), target, remote_cmd]
        cmd, env = self._wrap_sshpass(cmd)
        self.runner.run(cmd, env=env, title=f"reload nginx {target}")

    def _deploy_remote_logs(self):
        target = self._ssh_target()
        if not self.deploy_host_var.get().strip():
            self.log("✖ Rellena el Host", level="error")
            return
        remote_cmd = self._sudo_cmd("cd /opt/winus-video && sudo docker compose logs --tail=80 backend")
        cmd = ["ssh", *self._ssh_args(), target, remote_cmd]
        cmd, env = self._wrap_sshpass(cmd)
        self.runner.run(cmd, env=env, title=f"remote logs {target}")

    # ── LOG ──
    def log(self, text: str, level: str = "line"):
        self.log_text.configure(state="normal")
        self.log_text.insert("end", text + ("\n" if not text.endswith("\n") else ""), level)
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _clear_log(self):
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")

    def set_running(self, on: bool, title: str = ""):
        if on:
            self.status_badge.configure(
                text=f"⏵ {title[:40]}…" if title else "⏵ running",
                text_color=COLOR_ORANGE)
        else:
            self.status_badge.configure(text="● idle", text_color=COLOR_DIM)

    def run(self):
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.mainloop()

    def _on_close(self):
        save_config(self.cfg)
        self.root.destroy()


def main():
    app = VideoControlCenter()
    app.run()


if __name__ == "__main__":
    main()
