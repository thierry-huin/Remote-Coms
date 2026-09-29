@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM Winus Video Publisher — Windows Installer
REM Installs Python venv, Node.js check, GStreamer check,
REM publisher tools, and desktop shortcut
REM ============================================================

title Winus Video Publisher - Installer

set "INSTALL_DIR=%~dp0"
set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"
set "LOG=%INSTALL_DIR%\install.log"

REM Start logging
echo ============================================ > "%LOG%"
echo Winus Video Publisher Install Log >> "%LOG%"
echo %date% %time% >> "%LOG%"
echo ============================================ >> "%LOG%"
echo INSTALL_DIR=%INSTALL_DIR% >> "%LOG%"
echo. >> "%LOG%"

echo.
echo ============================================
echo    Winus Video Publisher - Windows Installer
echo ============================================
echo    (Log: install.log)
echo.

REM ---- Verify required files ----
if not exist "%INSTALL_DIR%\video_publisher.py" (
    echo [ERROR] video_publisher.py not found in %INSTALL_DIR%
    echo         Make sure the installer folder is complete.
    pause
    exit /b 1
)
if not exist "%INSTALL_DIR%\tools\publish.js" (
    echo [ERROR] tools\publish.js not found in %INSTALL_DIR%
    echo         Make sure the installer folder is complete.
    pause
    exit /b 1
)

REM ---- 1. Check Python ----
echo [1/7] Checking Python...
echo [1/7] Checking Python... >> "%LOG%"
where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    where python3 >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Python not found. >> "%LOG%"
        echo.
        echo [ERROR] Python not found.
        echo.
        echo   Download from: https://www.python.org/downloads/
        echo   IMPORTANT: Check "Add Python to PATH" during install.
        echo.
        pause
        exit /b 1
    )
    set "PYTHON=python3"
) else (
    set "PYTHON=python"
)

for /f "tokens=*" %%i in ('%PYTHON% --version 2^>^&1') do set PYVER=%%i
echo   Found: %PYVER%
echo   Python: %PYVER% >> "%LOG%"
where %PYTHON% >> "%LOG%" 2>&1

REM Check version >= 3.10
for /f "tokens=2 delims= " %%v in ("%PYVER%") do set PYVER_NUM=%%v
for /f "tokens=1,2 delims=." %%a in ("%PYVER_NUM%") do (
    set PYMAJOR=%%a
    set PYMINOR=%%b
)
if %PYMAJOR% LSS 3 (
    echo [ERROR] Python 3.10+ required, found %PYVER% >> "%LOG%"
    echo [ERROR] Python 3.10+ required, found %PYVER%
    pause
    exit /b 1
)
if %PYMAJOR% EQU 3 if %PYMINOR% LSS 10 (
    echo [ERROR] Python 3.10+ required, found %PYVER% >> "%LOG%"
    echo [ERROR] Python 3.10+ required, found %PYVER%
    pause
    exit /b 1
)

REM ---- 2. Check Node.js ----
echo.
echo [2/7] Checking Node.js...
echo [2/7] Checking Node.js... >> "%LOG%"
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found. >> "%LOG%"
    echo.
    echo [ERROR] Node.js not found.
    echo.
    echo   Download from: https://nodejs.org/
    echo   Install Node.js 20 LTS or later.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version 2^>^&1') do set NODEVER=%%i
echo   Found: Node.js %NODEVER%
echo   Node.js: %NODEVER% >> "%LOG%"

REM ---- 3. Check/Install GStreamer ----
echo.
echo [3/8] Checking GStreamer...
echo [3/8] Checking GStreamer... >> "%LOG%"
where gst-launch-1.0 >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   GStreamer not found, installing via winget...
    echo   GStreamer not found, trying winget... >> "%LOG%"
    winget install --id GStreamer.GStreamer -e --accept-source-agreements --accept-package-agreements >> "%LOG%" 2>&1
    REM Refresh PATH after install
    set "PATH=%PATH%;C:\gstreamer\1.0\msvc_x86_64\bin"
    where gst-launch-1.0 >nul 2>&1
    if !ERRORLEVEL! NEQ 0 (
        echo.
        echo   [ERROR] GStreamer could not be installed automatically.
        echo   Download manually from: https://gstreamer.freedesktop.org/download/
        echo   Install MSVC 64-bit ^(Complete^), then re-run this installer.
        echo   GStreamer manual install needed >> "%LOG%"
        pause
        exit /b 1
    )
    echo   GStreamer installed OK
    echo   GStreamer installed via winget >> "%LOG%"
) else (
    echo   Found: GStreamer OK
    echo   GStreamer OK >> "%LOG%"
)

REM ---- Check GStreamer WebRTC plugins (Mic/Talkback return audio) ----
REM Non-fatal: normal video/audio publishing works without these; only the
REM return-audio feature needs webrtcbin (plugins-bad) + nicesrc (libnice).
gst-inspect-1.0 webrtcbin >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   [!] webrtcbin not found - Mic/Talkback return audio will NOT be available.
    echo   [!] webrtcbin missing - return audio disabled >> "%LOG%"
    echo       Reinstall GStreamer choosing the "Complete" feature set from:
    echo       https://gstreamer.freedesktop.org/download/
) else (
    gst-inspect-1.0 nicesrc >nul 2>&1
    if !ERRORLEVEL! NEQ 0 (
        echo   [!] libnice ^(nicesrc^) not found - Mic/Talkback return audio will NOT be available.
        echo   [!] nicesrc missing - return audio disabled >> "%LOG%"
        echo       Reinstall GStreamer choosing the "Complete" feature set from:
        echo       https://gstreamer.freedesktop.org/download/
    ) else (
        echo   GStreamer WebRTC plugins OK ^(webrtcbin + nicesrc^)
        echo   GStreamer WebRTC plugins OK >> "%LOG%"
    )
)

REM ---- 4. Check/Install FFmpeg ----
echo.
echo [4/8] Checking FFmpeg...
echo [4/8] Checking FFmpeg... >> "%LOG%"
where ffmpeg >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   FFmpeg not found, installing via winget...
    echo   FFmpeg not found, trying winget... >> "%LOG%"
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements >> "%LOG%" 2>&1
    where ffmpeg >nul 2>&1
    if !ERRORLEVEL! NEQ 0 (
        echo   [!] FFmpeg install failed. Install manually:
        echo       https://www.gyan.dev/ffmpeg/builds/
        echo       Add ffmpeg.exe to PATH.
        echo   FFmpeg manual install needed >> "%LOG%"
    ) else (
        echo   FFmpeg installed OK
        echo   FFmpeg installed via winget >> "%LOG%"
    )
) else (
    echo   Found: FFmpeg OK
    echo   FFmpeg OK >> "%LOG%"
)

REM ---- 5. Create virtual environment ----
echo.
echo [5/8] Creating virtual environment...
echo. >> "%LOG%"
echo [5/8] Creating venv... >> "%LOG%"
if exist "%INSTALL_DIR%\.venv" (
    echo   .venv already exists, validating... >> "%LOG%"
    "%INSTALL_DIR%\.venv\Scripts\python.exe" --version >nul 2>&1
    if !ERRORLEVEL! NEQ 0 (
        echo   .venv is broken, recreating...
        echo   .venv broken, removing... >> "%LOG%"
        rmdir /s /q "%INSTALL_DIR%\.venv"
    ) else (
        echo   .venv OK, skipping
        echo   .venv valid, skipping >> "%LOG%"
    )
)
if not exist "%INSTALL_DIR%\.venv" (
    echo   Running: %PYTHON% -m venv "%INSTALL_DIR%\.venv" >> "%LOG%"
    %PYTHON% -m venv "%INSTALL_DIR%\.venv" >> "%LOG%" 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] Failed to create virtual environment >> "%LOG%"
        echo [ERROR] Failed to create virtual environment
        pause
        exit /b 1
    )
    echo   Created .venv
    echo   venv created OK >> "%LOG%"
)

REM ---- 6. Install Python packages ----
echo.
echo [6/8] Installing Python packages...
echo. >> "%LOG%"
echo [6/8] Installing packages... >> "%LOG%"
call "%INSTALL_DIR%\.venv\Scripts\activate.bat"
echo   pip location: >> "%LOG%"
where pip >> "%LOG%" 2>&1
python -m pip install --upgrade pip >> "%LOG%" 2>&1
echo   Installing customtkinter... >> "%LOG%"
python -m pip install customtkinter sounddevice numpy >> "%LOG%" 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] pip install failed - see install.log >> "%LOG%"
    echo [ERROR] pip install failed - see install.log for details
    pause
    exit /b 1
)
echo   All packages installed
echo   All packages installed OK >> "%LOG%"

REM ---- PyGObject (Mic/Talkback return audio) ----
REM Non-fatal: not reliably pip-installable on Windows without MSYS2/conda.
REM If missing, publishing still works fine; only return audio is unavailable.
python -c "import gi; gi.require_version('Gst','1.0'); gi.require_version('GstWebRTC','1.0'); gi.require_version('GstSdp','1.0'); from gi.repository import Gst, GstWebRTC, GstSdp" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   [!] PyGObject ^(gi / GstWebRTC / GstSdp^) not available in the venv.
    echo   [!] PyGObject not available in venv - trying MSYS2 fallback >> "%LOG%"
    echo   Attempting automatic install via MSYS2 ^(best-effort, can take several minutes^)...
    call :install_msys2_pygobject
) else (
    echo   PyGObject OK ^(return audio available^)
    echo   PyGObject OK >> "%LOG%"
)

REM ---- 7. Install Node.js dependencies ----
echo.
echo [7/8] Installing Node.js dependencies...
echo. >> "%LOG%"
echo [7/8] Installing Node.js dependencies... >> "%LOG%"

if not exist "%INSTALL_DIR%\tools\package.json" (
    echo {"name":"winus-video-publisher","version":"1.0.0","private":true,"dependencies":{"ws":"^8.18.0"}} > "%INSTALL_DIR%\tools\package.json"
)
pushd "%INSTALL_DIR%\tools"
call npm install --silent >> "%LOG%" 2>&1
popd
echo   Node dependencies installed
echo   Node dependencies OK >> "%LOG%"

REM ---- 8. Create launcher and desktop shortcut ----
echo.
echo [8/8] Creating launcher...
echo. >> "%LOG%"
echo [8/8] Creating launcher... >> "%LOG%"

REM Create Video_Publisher.bat
echo @echo off> "%INSTALL_DIR%\Video_Publisher.bat"
echo cd /d "%%~dp0">> "%INSTALL_DIR%\Video_Publisher.bat"
echo call .venv\Scripts\activate.bat>> "%INSTALL_DIR%\Video_Publisher.bat"
echo python video_publisher.py>> "%INSTALL_DIR%\Video_Publisher.bat"
echo pause>> "%INSTALL_DIR%\Video_Publisher.bat"

if exist "%INSTALL_DIR%\Video_Publisher.bat" (
    echo   Created Video_Publisher.bat
    echo   Video_Publisher.bat created OK >> "%LOG%"
) else (
    echo   [ERROR] Failed to create Video_Publisher.bat
    echo   [ERROR] Video_Publisher.bat NOT created >> "%LOG%"
)

REM Create desktop shortcut via PowerShell
set "DESKTOP=%USERPROFILE%\Desktop"
echo   Desktop: %DESKTOP% >> "%LOG%"
powershell -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut('%DESKTOP%\Winus Video Publisher.lnk');$s.TargetPath='%INSTALL_DIR%\Video_Publisher.bat';$s.WorkingDirectory='%INSTALL_DIR%';$s.Description='Winus Video Publisher';$s.Save()" >> "%LOG%" 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   Desktop shortcut created
    echo   Shortcut created OK >> "%LOG%"
) else (
    echo   [!] Could not create desktop shortcut (not critical)
    echo   Shortcut creation failed >> "%LOG%"
)

REM ---- Done ----
echo. >> "%LOG%"
echo ============================================ >> "%LOG%"
echo INSTALL COMPLETE %date% %time% >> "%LOG%"
echo ============================================ >> "%LOG%"

echo.
echo ============================================
echo    Installation complete!
echo ============================================
echo.
echo    Run: double-click Video_Publisher.bat
echo    Or:  Desktop shortcut
echo.
echo    Log saved to: install.log
echo.
pause
exit /b 0

REM ============================================================
REM MSYS2 PyGObject fallback (Mic/Talkback return audio)
REM Best-effort, non-fatal: video/audio publishing is unaffected either way.
REM tools/return-audio-receiver.py needs PyGObject + GstWebRTC/GstSdp
REM typelibs, which are NOT reliably pip-installable for python.org's
REM Windows Python. MSYS2's mingw-w64 Python ships them via pacman instead.
REM ============================================================
:install_msys2_pygobject
where winget >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   [!] winget not available - skipping automatic MSYS2 install.
    goto :msys2_manual_hint
)
if not exist "C:\msys64\usr\bin\bash.exe" (
    echo   Installing MSYS2 via winget...
    echo   Installing MSYS2 via winget... >> "%LOG%"
    winget install --id MSYS2.MSYS2 -e --accept-source-agreements --accept-package-agreements >> "%LOG%" 2>&1
)
if not exist "C:\msys64\usr\bin\bash.exe" (
    echo   [!] MSYS2 install failed or not found at C:\msys64.
    echo   [!] MSYS2 not found after winget install >> "%LOG%"
    goto :msys2_manual_hint
)
echo   Updating MSYS2 core packages ^(first run, can take a few minutes^)...
C:\msys64\usr\bin\bash.exe -lc "pacman -Sy --noconfirm" >> "%LOG%" 2>&1
C:\msys64\usr\bin\bash.exe -lc "pacman -Su --noconfirm" >> "%LOG%" 2>&1
echo   Installing PyGObject + GStreamer WebRTC packages...
C:\msys64\usr\bin\bash.exe -lc "pacman -S --needed --noconfirm mingw-w64-x86_64-python-gobject mingw-w64-x86_64-gst-plugins-base mingw-w64-x86_64-gst-plugins-good mingw-w64-x86_64-gst-plugins-bad mingw-w64-x86_64-python-sounddevice mingw-w64-x86_64-python-numpy" >> "%LOG%" 2>&1
if not exist "C:\msys64\mingw64\bin\python3.exe" (
    echo   [!] MSYS2 package install failed - see install.log
    echo   [!] MSYS2 mingw64 python3.exe not found after pacman >> "%LOG%"
    goto :msys2_manual_hint
)
"C:\msys64\mingw64\bin\python3.exe" -c "import gi; gi.require_version('Gst','1.0'); gi.require_version('GstWebRTC','1.0'); gi.require_version('GstSdp','1.0'); from gi.repository import Gst, GstWebRTC, GstSdp" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   [!] MSYS2 PyGObject verification failed - see install.log
    echo   [!] MSYS2 PyGObject import check failed >> "%LOG%"
    goto :msys2_manual_hint
)
python "%INSTALL_DIR%\_set_config_value.py" return_audio_python "C:\msys64\mingw64\bin\python3.exe" >> "%LOG%" 2>&1
echo   PyGObject OK via MSYS2 ^(return audio available^)
echo   MSYS2 PyGObject OK, return_audio_python configured >> "%LOG%"
goto :eof

:msys2_manual_hint
echo       Mic/Talkback return audio will NOT be available on this PC.
echo       Video/audio publishing is NOT affected.
echo       To enable it manually: install MSYS2 ^(https://www.msys2.org/^), then run:
echo         pacman -S mingw-w64-x86_64-python-gobject mingw-w64-x86_64-gst-plugins-bad
echo         mingw-w64-x86_64-gst-plugins-good mingw-w64-x86_64-python-sounddevice mingw-w64-x86_64-python-numpy
echo       then add "return_audio_python": "C:\\msys64\\mingw64\\bin\\python3.exe"
echo       to %%USERPROFILE%%\.config\winus-video-publisher.json
goto :eof
