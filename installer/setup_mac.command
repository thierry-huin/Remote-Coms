#!/bin/bash
# ============================================================
# Winus Video Publisher — macOS Auto-Installer
# Double-click this file to install everything automatically.
# No technical knowledge required.
# ============================================================

trap 'echo ""; echo "❌ Error en la instalación. Revisa los mensajes arriba."; echo ""; read -p "Presiona Enter para cerrar..."; exit 1' ERR

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Winus Video Publisher"
VENV_DIR="$SCRIPT_DIR/.venv"

clear
echo "╔══════════════════════════════════════════╗"
echo "║  Winus Video Publisher — macOS Installer  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ---- 0. Architecture check ----
# Apple dropped Intel (x86_64) support entirely starting with macOS 27
# ("Golden Gate") -- Intel Macs simply cannot run that OS version. As a
# direct consequence, Homebrew (which this installer relies on for
# gstreamer/pygobject3/etc.) demoted Intel x86_64 to "Tier 3" in Homebrew
# 7.0.0 (Sept 2026): it no longer builds precompiled binaries ("bottles")
# for Intel, so a fresh `brew install gstreamer` (and its many
# dependencies) on an Intel Mac now falls back to compiling everything
# from source -- routinely taking well over an hour, or failing outright.
# Rather than let a first-time Intel setup silently hang/fail deep inside
# step 2, fail fast here with a clear explanation. Machines that already
# have these Homebrew formulas installed from before this cutoff are NOT
# affected by this check re-running later (the installer only calls
# `brew install` for packages not already present), but a brand-new
# install on Intel is no longer realistically supportable.
if [ "$(uname -m)" != "arm64" ]; then
    echo "❌ Este instalador ahora requiere una Mac con Apple Silicon (chip M1/M2/M3/M4 — arquitectura ARM)."
    echo ""
    echo "   Tu Mac es Intel (x86_64). Apple eliminó el soporte para Mac Intel a partir de"
    echo "   macOS 27, y como consecuencia Homebrew (que este instalador usa para instalar"
    echo "   GStreamer, PyGObject, etc.) dejó de generar instaladores precompilados para"
    echo "   Intel: cualquier instalación nueva ahora intenta compilar todo desde cero,"
    echo "   lo cual puede tardar horas o fallar directamente."
    echo ""
    echo "   Usá una Mac con Apple Silicon para publicar con Winus Video Publisher."
    echo ""
    read -p "Presiona Enter para cerrar..."
    exit 1
fi

# ---- Verify required files ----
if [ ! -f "$SCRIPT_DIR/video_publisher.py" ]; then
    echo "❌ video_publisher.py no encontrado en $SCRIPT_DIR"
    echo "   Asegúrate de que la carpeta del installer está completa."
    read -p "Presiona Enter para cerrar..."
    exit 1
fi
if [ ! -f "$SCRIPT_DIR/tools/publish.js" ]; then
    echo "❌ tools/publish.js no encontrado en $SCRIPT_DIR"
    echo "   Asegúrate de que la carpeta del installer está completa."
    read -p "Presiona Enter para cerrar..."
    exit 1
fi

# ---- 1. Homebrew ----
echo "▸ [1/7] Verificando Homebrew..."
if ! command -v brew &>/dev/null; then
    echo "  Instalando Homebrew (puede pedir tu contraseña)..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
        SHELL_PROFILE="$HOME/.zprofile"
        if ! grep -q 'homebrew' "$SHELL_PROFILE" 2>/dev/null; then
            echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> "$SHELL_PROFILE"
        fi
    fi
    echo "  ✓ Homebrew instalado"
else
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
    echo "  ✓ Homebrew OK"
fi

# ---- 2. System dependencies ----
echo "▸ [2/7] Instalando dependencias del sistema..."

# Install node, gstreamer (+ webrtc/ICE plugins for Mic/Talkback return audio), ffmpeg
# and the build deps needed to install PyGObject (gi) into the venv below.
# NOTE: libnice-gstreamer (not just libnice) is required for webrtcbin's ICE support —
# Homebrew's gst-plugins-bad bottle is NOT linked against libnice, so "nicesrc"/"nicesink"
# only show up once this separate formula is installed. See:
# https://github.com/Homebrew/homebrew-core/pull/183884#issuecomment-2371071966
for pkg in node gstreamer gst-plugins-bad gst-plugins-good libnice libnice-gstreamer ffmpeg pkg-config gobject-introspection cairo; do
    if ! brew list "$pkg" &>/dev/null; then
        echo "  Instalando $pkg..."
        brew install "$pkg" 2>/dev/null
    fi
done

if gst-inspect-1.0 webrtcbin &>/dev/null && gst-inspect-1.0 nicesrc &>/dev/null; then
    echo "  ✓ GStreamer WebRTC plugins OK (webrtcbin + nicesrc)"
else
    echo "  [!] webrtcbin/nicesrc no disponibles — el audio de retorno (Mic/Talkback) no funcionará."
    echo "      Prueba: brew reinstall libnice-gstreamer gst-plugins-bad"
fi

# Find best available Python 3.10+ (prefer what's already installed). Only
# /opt/homebrew is checked -- /usr/local (Intel Homebrew's prefix) is dead
# code now that this installer requires Apple Silicon (see the architecture
# check above).
PY=""
PYVER=""
for v in 3.14 3.13 3.12 3.11 3.10; do
    p="/opt/homebrew/bin/python${v}"
    if [ -x "$p" ]; then PY="$p"; PYVER="$v"; break; fi
done

# If no Python found, install 3.12
if [ -z "$PY" ]; then
    echo "  Instalando python@3.12..."
    brew install python@3.12 2>/dev/null
    PY="/opt/homebrew/bin/python3.12"
    PYVER="3.12"
fi

# Install matching python-tk
TK_PKG="python-tk@${PYVER}"
if ! brew list "$TK_PKG" &>/dev/null; then
    echo "  Instalando $TK_PKG..."
    brew install "$TK_PKG" 2>/dev/null || echo "  [!] $TK_PKG no disponible, intentando python-tk genérico..."
fi

if [ ! -x "$PY" ]; then
    echo "❌ Python 3.10+ no encontrado."
    read -p "Presiona Enter para cerrar..."
    exit 1
fi
echo "  ✓ Python: $($PY --version)"
echo "  ✓ Node.js: $(node --version)"

# ---- 3. Virtual environment ----
echo "▸ [3/7] Configurando entorno Python..."
if [ -d "$VENV_DIR" ]; then
    VENV_PY_VER=$("$VENV_DIR/bin/python3" --version 2>/dev/null || echo "none")
    EXPECTED_MINOR=$(echo "$PYVER" | cut -d. -f2)
    if [[ "$VENV_PY_VER" != *"3.${EXPECTED_MINOR}"* ]]; then
        echo "  Recreando entorno para Python $PYVER..."
        rm -rf "$VENV_DIR"
    fi
fi
if [ ! -d "$VENV_DIR" ]; then
    "$PY" -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"
echo "  ✓ Entorno virtual OK"

# ---- 4. Python packages ----
echo "▸ [4/7] Instalando paquetes Python..."
pip install --quiet --upgrade pip 2>/dev/null
pip install --quiet customtkinter sounddevice numpy 2>/dev/null
echo "  ✓ Paquetes Python OK"

# PyGObject (gi + GstWebRTC/GstSdp typelibs), needed by tools/return-audio-receiver.py
# for the Mic/Talkback return-audio feature. Installed via Homebrew (NOT pip: pygobject
# almost never builds correctly from a pip wheel on macOS). Since it's tied to Homebrew's
# own Python (not our venv), we resolve that interpreter and pass it through explicitly
# via RETURN_AUDIO_PYTHON — publish.js uses it instead of whatever "python3" is on PATH.
echo "  Instalando PyGObject (audio de retorno Mic/Talkback)..."
GI_PYTHON=""
if ! brew list pygobject3 &>/dev/null; then
    brew install pygobject3 2>/dev/null
fi
for p in "$(brew --prefix)/bin/python3" /opt/homebrew/bin/python3; do
    if [ -x "$p" ] && "$p" -c "import gi; gi.require_version('Gst','1.0'); gi.require_version('GstWebRTC','1.0'); gi.require_version('GstSdp','1.0'); from gi.repository import Gst, GstWebRTC, GstSdp" 2>/dev/null; then
        GI_PYTHON="$p"
        break
    fi
done
if [ -n "$GI_PYTHON" ]; then
    echo "  ✓ PyGObject OK (audio de retorno disponible, interprete: $GI_PYTHON)"
    # return-audio-receiver.py routes decoded audio via sounddevice/numpy ("Tie-line"
    # device+channel routing) — install into GI_PYTHON too, since it's a different
    # interpreter than the venv where these are already installed for the GUI.
    "$GI_PYTHON" -m pip install --quiet --user sounddevice numpy 2>/dev/null \
        || "$GI_PYTHON" -m pip install --quiet --user --break-system-packages sounddevice numpy 2>/dev/null
    if "$GI_PYTHON" -c "import sounddevice, numpy" 2>/dev/null; then
        echo "  ✓ sounddevice/numpy OK para $GI_PYTHON"
    else
        echo "  [!] No se pudo instalar sounddevice/numpy para $GI_PYTHON — el audio de"
        echo "      retorno usará la salida de audio por defecto en vez del dispositivo/canal elegido."
    fi
else
    echo "  [!] PyGObject no disponible — el audio de retorno (Mic/Talkback) no estará disponible."
    echo "      (La publicación de video/audio normal no se ve afectada.)"
fi

# ---- 5. Node.js dependencies ----
echo "▸ [5/7] Instalando dependencias Node.js..."
if [ ! -f "$SCRIPT_DIR/tools/package.json" ]; then
    cat > "$SCRIPT_DIR/tools/package.json" << 'PKG'
{
  "name": "winus-video-publisher",
  "version": "1.0.0",
  "private": true,
  "dependencies": { "ws": "^8.18.0" }
}
PKG
fi
cd "$SCRIPT_DIR/tools"
npm install --silent 2>&1 | tail -1
cd "$SCRIPT_DIR"
echo "  ✓ Dependencias Node.js OK"

# ---- 6. Create .app bundle ----
echo "▸ [6/7] Creando aplicación..."
APP_DIR="$HOME/Desktop/$APP_NAME.app"
APP_CONTENTS="$APP_DIR/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"

mkdir -p "$APP_MACOS" "$APP_RESOURCES"

cat > "$APP_RESOURCES/run.command" << RUN_EOF
#!/bin/bash
if [ -f /opt/homebrew/bin/brew ]; then
    eval "\$(/opt/homebrew/bin/brew shellenv)"
fi
cd "$SCRIPT_DIR"
source "$VENV_DIR/bin/activate"
export RETURN_AUDIO_PYTHON="$GI_PYTHON"
python3 "$SCRIPT_DIR/video_publisher.py"
RUN_EOF
chmod +x "$APP_RESOURCES/run.command"

cat > "$APP_MACOS/launch" << 'LAUNCH_EOF'
#!/bin/bash
DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
open -a Terminal "$DIR/run.command"
LAUNCH_EOF
chmod +x "$APP_MACOS/launch"

cat > "$APP_CONTENTS/Info.plist" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Winus Video Publisher</string>
    <key>CFBundleDisplayName</key>
    <string>Winus Video Publisher</string>
    <key>CFBundleIdentifier</key>
    <string>com.winus.video-publisher</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleExecutable</key>
    <string>launch</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSCameraUsageDescription</key>
    <string>Winus Video Publisher necesita acceso a la cámara para capturar video.</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
</dict>
</plist>
PLIST_EOF

LOGO="$SCRIPT_DIR/logo.png"
if [ -f "$LOGO" ]; then
    echo "  Generando icono de la aplicación..."
    ICONSET="$APP_RESOURCES/AppIcon.iconset"
    mkdir -p "$ICONSET"
    sips -z 16 16     "$LOGO" --out "$ICONSET/icon_16x16.png"      > /dev/null 2>&1
    sips -z 32 32     "$LOGO" --out "$ICONSET/icon_16x16@2x.png"   > /dev/null 2>&1
    sips -z 32 32     "$LOGO" --out "$ICONSET/icon_32x32.png"      > /dev/null 2>&1
    sips -z 64 64     "$LOGO" --out "$ICONSET/icon_32x32@2x.png"   > /dev/null 2>&1
    sips -z 128 128   "$LOGO" --out "$ICONSET/icon_128x128.png"    > /dev/null 2>&1
    sips -z 256 256   "$LOGO" --out "$ICONSET/icon_128x128@2x.png" > /dev/null 2>&1
    sips -z 256 256   "$LOGO" --out "$ICONSET/icon_256x256.png"    > /dev/null 2>&1
    sips -z 512 512   "$LOGO" --out "$ICONSET/icon_256x256@2x.png" > /dev/null 2>&1
    sips -z 512 512   "$LOGO" --out "$ICONSET/icon_512x512.png"    > /dev/null 2>&1
    sips -z 1024 1024 "$LOGO" --out "$ICONSET/icon_512x512@2x.png" > /dev/null 2>&1
    iconutil -c icns "$ICONSET" -o "$APP_RESOURCES/AppIcon.icns" 2>/dev/null
    rm -rf "$ICONSET"
    echo "  ✓ Icono de app generado"
fi

echo "  ✓ Aplicación creada en el Escritorio"

# ---- 7. Backup .command launcher ----
echo "▸ [7/7] Creando lanzador de respaldo..."
LAUNCHER="$HOME/Desktop/$APP_NAME.command"
cat > "$LAUNCHER" << LAUNCHER_EOF
#!/bin/bash
if [ -f /opt/homebrew/bin/brew ]; then
    eval "\$(/opt/homebrew/bin/brew shellenv)"
fi
cd "$SCRIPT_DIR"
source "$VENV_DIR/bin/activate"
export RETURN_AUDIO_PYTHON="$GI_PYTHON"
python3 "$SCRIPT_DIR/video_publisher.py"
LAUNCHER_EOF
chmod +x "$LAUNCHER"
echo "  ✓ Lanzador .command creado"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   ✓ Instalación completada               ║"
echo "╠══════════════════════════════════════════╣"
echo "║                                          ║"
echo "║   En el Escritorio encontrarás:          ║"
echo "║                                          ║"
echo "║   📦 Winus Video Publisher.app           ║"
echo "║   📄 Winus Video Publisher.command       ║"
echo "║                                          ║"
echo "║   Doble-click en cualquiera para abrir.  ║"
echo "║                                          ║"
echo "╚══════════════════════════════════════════╝"
echo ""
read -p "Presiona Enter para cerrar..."
