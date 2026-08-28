#!/usr/bin/env bash
# PulseStream EC2 first-boot bootstrap (Ubuntu 24.04 LTS).
#
# What it does:   installs Docker Engine + compose plugin, clones the repo.
# What it does NOT do: no secrets here (user-data is readable via instance
# metadata). Credentials are added by the operator over SSH afterwards —
# see infra/aws/README.md step 4.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/YOUR_USER/YOUR_REPO.git}"
REPO_DIR="/opt/pulsestream"

log() { echo "[pulsestream-bootstrap] $*"; }

log "installing docker"
apt-get update -y
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

log "cloning ${REPO_URL} into ${REPO_DIR}"
git clone "${REPO_URL}" "${REPO_DIR}"

log "done. Operator next steps (SSH):"
echo "  cd ${REPO_DIR}"
echo "  cp infra/aws/env.production.template .env.production   # then edit values"
echo "  docker build -t pulsestream-backend:latest ."
echo "  docker build -t pulsestream-frontend:latest ./frontend"
echo "  sudo docker compose -f infra/docker-compose.prod.yml --env-file .env.production up -d"
