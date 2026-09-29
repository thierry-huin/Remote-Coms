#!/usr/bin/env bash
# Winus Video — GStreamer Publisher (video only)
# Sends H.264 RTP to the mediasoup PlainTransport.
#
# Usage:
#   ./gstreamer-publish.sh <server_rtp_ip> <rtp_port> [local_bind_port]
#
# local_bind_port: optional. When set, the outgoing udpsink binds its LOCAL
# source port to this fixed value instead of letting the OS pick one. Used
# by publish.js's startVideoEncoder() so a live restart (e.g. toggling the
# clock overlay) keeps sending from the same source tuple mediasoup's
# comedia-mode PlainTransport already locked onto -- otherwise a fresh
# ephemeral port on respawn would make mediasoup silently ignore the stream.

set -euo pipefail

SERVER_IP="${1:?Usage: $0 <server_ip> <rist_port>}"
RTP_PORT="${2:?Usage: $0 <server_ip> <rist_port>}"
LOCAL_BIND_PORT="${3:-0}"

BITRATE="${BITRATE:-4000}"
FPS="${FPS:-30}"
DEINTERLACE="${DEINTERLACE:-0}"
SOURCE="${SOURCE:-videotestsrc}"
DEVICE="${DEVICE:-/dev/video0}"
DEVICE_INDEX="${DEVICE_INDEX:-0}"
DEVICE_NAME="${DEVICE_NAME:-}"
PERSISTENT_ID="${PERSISTENT_ID:-}"
KEYFRAME_S="${KEYFRAME_S:-2}"

CLOCK_OVERLAY="${CLOCK_OVERLAY:-0}"
KEYFRAME_INTERVAL=$((FPS * KEYFRAME_S))

echo "=== Winus Video Publisher ==="
echo "  Server:      ${SERVER_IP}:${RTP_PORT} "
echo "  Bitrate:     ${BITRATE} kbps"
echo "  Deinterlace: ${DEINTERLACE}"
echo "  Source:       ${SOURCE}"
echo "  Device:      ${DEVICE} / index=${DEVICE_INDEX}"
echo "  Keyframe:    every ${KEYFRAME_S}s (${KEYFRAME_INTERVAL} frames)"
echo "============================"

# Build source element
case "$SOURCE" in
  videotestsrc)
    SRC="videotestsrc is-live=true pattern=ball"
    ;;
  v4l2src)
    SRC="v4l2src device=${DEVICE}"
    ;;
  decklinkvideosrc)
    DECKLINK_ID=""
    [ -n "$PERSISTENT_ID" ] && DECKLINK_ID="persistent-id=$PERSISTENT_ID" || DECKLINK_ID="device-number=${DEVICE_INDEX}"
    SRC="decklinkvideosrc ${DECKLINK_ID} mode=auto connection=auto"
    ;;
  avfvideosrc)
    SRC="avfvideosrc device-index=${DEVICE_INDEX} ! video/x-raw"
    ;;
  mfvideosrc)
    SRC="mfvideosrc device-index=${DEVICE_INDEX}"
    ;;
  ksvideosrc)
    SRC="ksvideosrc device-index=${DEVICE_INDEX}"
    ;;
  ximagesrc*)
    SRC="ximagesrc use-damage=false show-pointer=true"
    ;;
  pipewiresrc*)
    SRC="$SOURCE"
    ;;
  d3d11screencapturesrc*)
    SRC="d3d11screencapturesrc show-cursor=true"
    ;;
  *)
    SRC="$SOURCE"
    ;;
esac

# Deinterlace filter
DEINT=""
if [ "$DEINTERLACE" = "1" ]; then
  DEINT="! deinterlace method=linear"
fi

# Audio (main outgoing audio AND PGM/Talkback return audio) is handled
# entirely by publish.js now, as its own directly-managed Node child
# process(es) -- see startAudioEncoder() there -- so that the audio buffer
# (Opus frame duration) can be changed live (killed + respawned) without
# touching this video pipeline at all. This script is video-only.

# Detect hardware encoder on macOS
USE_VTENC=false
if [ "$(uname)" = "Darwin" ] && gst-inspect-1.0 vtenc_h264 >/dev/null 2>&1; then
  USE_VTENC=true
fi

# Optional fixed local source port for the outgoing udpsink (see
# LOCAL_BIND_PORT above). bind-port defaults to 0 (OS-assigned) in GStreamer,
# so it's safe to always pass it through.

# Video — foreground. `exec` REPLACES this script's own process image with
# gst-launch-1.0 (same PID, no child fork) instead of running it as a
# waited-on subprocess. Without this, sending a signal to the script's PID
# (as publish.js's startVideoEncoder() does to restart/stop the video
# encoder) only kills THIS bash process -- with no trap installed, bash
# terminates without forwarding the signal, leaving gst-launch-1.0 running
# as an orphan that keeps the camera/capture device open (and, on restart,
# keeps the fixed local RTP port bound so the replacement process fails to
# bind it). `exec` makes that whole class of bug impossible: there is only
# ever ONE process here.
if [ "$USE_VTENC" = "true" ]; then
  # macOS: VideoToolbox hardware encoder (no videoconvert needed)
  exec gst-launch-1.0 -v \
    ${SRC} \
    ${DEINT} \
    $([ "$CLOCK_OVERLAY" = "1" ] && echo '! clockoverlay halignment=left valignment=top font-desc="Monospace,9" shaded-background=true time-format="%H:%M:%S"') \
    ! vtenc_h264 \
        bitrate=${BITRATE} \
        realtime=true \
        allow-frame-reordering=false \
        max-keyframe-interval=${KEYFRAME_INTERVAL} \
    ! h264parse \
    ! rtph264pay pt=101 config-interval=-1 ssrc=1111 \
    ! udpsink host=${SERVER_IP} port=${RTP_PORT} bind-port=${LOCAL_BIND_PORT} sync=false
else
  # Linux/Windows: x264enc software encoder
  exec gst-launch-1.0 -v \
    ${SRC} \
    ${DEINT} \
    ! videoconvert \
    $([ "$CLOCK_OVERLAY" = "1" ] && echo '! clockoverlay halignment=left valignment=top font-desc="Monospace,9" shaded-background=true time-format="%H:%M:%S"') \
    ! x264enc \
        bitrate=${BITRATE} \
        speed-preset=ultrafast \
        tune=zerolatency \
        key-int-max=${KEYFRAME_INTERVAL} \
        bframes=0 \
    ! "video/x-h264,profile=baseline" \
    ! h264parse \
    ! rtph264pay pt=101 config-interval=-1 ssrc=1111 \
    ! udpsink host=${SERVER_IP} port=${RTP_PORT} bind-port=${LOCAL_BIND_PORT} sync=false
fi
