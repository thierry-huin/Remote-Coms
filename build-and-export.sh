#!/usr/bin/env bash
# Winus Video — Build Docker images and export for Proxmox/offline deploy
#
# Creates a tar.gz with pre-built images + config files.
# On the target: extract + run deploy.sh

set -euo pipefail

cd "$(dirname "$0")"
TIMESTAMP=$(date +%Y%m%d.%H%M)
EXPORT_NAME="winus-video-server-${TIMESTAMP}"
EXPORT_DIR="/tmp/${EXPORT_NAME}"

echo "=== Winus Video — Build & Export ==="

# 1. Build Docker images
echo "▸ Building Docker images..."
docker compose build

# 2. Save images
echo "▸ Exporting Docker images..."
mkdir -p "$EXPORT_DIR"
docker save winus-video-backend:latest | gzip > "${EXPORT_DIR}/backend.tar.gz"
docker save nginx:alpine | gzip > "${EXPORT_DIR}/nginx.tar.gz"
docker pull coturn/coturn:latest
docker save coturn/coturn:latest | gzip > "${EXPORT_DIR}/coturn.tar.gz"

# 3. Copy project files
echo "▸ Copying project files..."
cp docker-compose.yml "${EXPORT_DIR}/"
cp .env.template "${EXPORT_DIR}/"
cp deploy.sh "${EXPORT_DIR}/"
cp -r nginx/ "${EXPORT_DIR}/nginx/"
cp -r coturn/ "${EXPORT_DIR}/coturn/"
cp -r web/ "${EXPORT_DIR}/web/"
cp -r tools/ "${EXPORT_DIR}/tools/"
cp -r backend/src/ "${EXPORT_DIR}/backend-src/"
cp backend/package.json "${EXPORT_DIR}/"
cp backend/Dockerfile "${EXPORT_DIR}/"
cp control_center.py "${EXPORT_DIR}/" 2>/dev/null || true
cp video_publisher.py "${EXPORT_DIR}/" 2>/dev/null || true
cp -r installer/ "${EXPORT_DIR}/installer/" 2>/dev/null || true
mkdir -p "${EXPORT_DIR}/certs"

# 4. Create deploy-proxmox.sh wrapper
cat > "${EXPORT_DIR}/deploy-proxmox.sh" << 'DEPLOY'
#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="/opt/winus-video"
echo "=== Winus Video — Proxmox Deploy ==="

# Create directory
sudo mkdir -p "$INSTALL_DIR"
sudo cp -r . "$INSTALL_DIR/"
sudo chown -R "$(whoami):$(whoami)" "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Load pre-built images
echo "▸ Loading Docker images..."
docker load < backend.tar.gz
docker load < nginx.tar.gz
docker load < coturn.tar.gz
rm -f backend.tar.gz nginx.tar.gz coturn.tar.gz

# Restructure backend
mkdir -p backend/src
mv backend-src/* backend/src/
rmdir backend-src
mv package.json backend/
mv Dockerfile backend/

# Run deploy
bash deploy.sh
DEPLOY
chmod +x "${EXPORT_DIR}/deploy-proxmox.sh"

# 5. Create tar.gz
echo "▸ Creating archive..."
TAR_FILE="${PWD}/${EXPORT_NAME}.tar.gz"
cd /tmp
tar czf "$TAR_FILE" "$EXPORT_NAME"
rm -rf "$EXPORT_DIR"

SIZE_MB=$(du -sh "$TAR_FILE" | awk '{print $1}')
echo ""
echo "════════════════════════════════════════════"
echo "  ✓ Export: ${TAR_FILE}"
echo "  Size: ${SIZE_MB}"
echo ""
echo "  Deploy on Proxmox:"
echo "    scp ${EXPORT_NAME}.tar.gz user@host:/tmp/"
echo "    ssh user@host 'cd /tmp && tar xzf ${EXPORT_NAME}.tar.gz && cd ${EXPORT_NAME} && bash deploy-proxmox.sh'"
echo "════════════════════════════════════════════"
