#!/usr/bin/env bash
# Winus Video Server — Deploy Script
# Run on target server (Proxmox LXC, VM, or bare metal).
#
# Prerequisites: Docker + Docker Compose installed.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/.../deploy.sh | bash
#   # or copy the winus-video/ directory and run:
#   cd /opt/winus-video && bash deploy.sh

set -euo pipefail

INSTALL_DIR="/opt/winus-video"
cd "$INSTALL_DIR"

echo "=== Winus Video Server — Deploy ==="
echo ""

# 1. Check Docker
if ! command -v docker &>/dev/null; then
  echo "▸ Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  echo "  ✓ Docker installed. Log out and back in for group permissions."
fi

# 2. Generate .env if missing
if [ ! -f .env ]; then
  echo "▸ Creating .env from template..."
  cp .env.template .env

  # Auto-detect public IP
  PUBLIC_IP=$(curl -s4 ifconfig.me 2>/dev/null || echo "127.0.0.1")
  LOCAL_IP=$(hostname -I | awk '{print $1}')
  sed -i "s/YOUR_PUBLIC_IP/$PUBLIC_IP/g" .env
  sed -i "s/YOUR_LOCAL_IP/$LOCAL_IP/g" .env
  # Generate random JWT secret
  JWT_SECRET=$(openssl rand -hex 24)
  sed -i "s/CHANGE_ME_random_string_here/$JWT_SECRET/" .env
  echo "  ✓ .env created (IP: $PUBLIC_IP, local: $LOCAL_IP)"
  echo "  ⚠ Review .env and adjust if needed before starting."
fi

# 3. Generate self-signed cert if missing
if [ ! -f certs/cert.pem ]; then
  echo "▸ Generating self-signed certificate..."
  mkdir -p certs
  PUBLIC_IP=$(grep EXTERNAL_IP .env | cut -d= -f2)
  openssl req -x509 -newkey rsa:2048 \
    -keyout certs/key.pem -out certs/cert.pem \
    -days 365 -nodes \
    -subj "/CN=winus-video" \
    -addext "subjectAltName=IP:${PUBLIC_IP},DNS:localhost" 2>/dev/null
  echo "  ✓ Certificate generated"
fi

# 4. Build and start
echo "▸ Building and starting containers..."
docker compose up -d --build

echo ""
echo "════════════════════════════════════════════"
echo "  ✅ Winus Video Server deployed!"
echo ""
echo "  Web viewer:  https://${PUBLIC_IP:-localhost}:9443"
echo "  Health:      https://${PUBLIC_IP:-localhost}:9443/health"
echo "  API stats:   https://${PUBLIC_IP:-localhost}:9443/api/stats"
echo ""
echo "  Ports opened:"
echo "    9443/tcp   — HTTPS + WebSocket"
echo "    9080/tcp   — HTTP redirect"
echo "    10201-10400/udp — mediasoup RTP"
echo "    10502-10600/udp — SRT/RIST relay ingest"
echo "    3480/udp+tcp    — TURN (standalone coturn, no Intercom dependency)"
echo "    49201-49250/udp — TURN relay range (coturn/turnserver.conf)"
echo "════════════════════════════════════════════"
