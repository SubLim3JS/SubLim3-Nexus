#!/usr/bin/env bash
set -euo pipefail

readonly APP_DIR="/opt/sublim3-nexus"
readonly DATA_DIR="/var/lib/sublim3-nexus"
readonly SERVICE_NAME="sublim3-nexus.service"
readonly SERVICE_USER="nexus"
readonly REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo: sudo ./scripts/install.sh" >&2
  exit 1
fi

if [[ "${REPOSITORY_ROOT}" != "${APP_DIR}" ]]; then
  echo "Expected the repository at ${APP_DIR}; found ${REPOSITORY_ROOT}." >&2
  exit 1
fi

if [[ ! -x /usr/bin/node ]]; then
  echo "Node.js is not installed at /usr/bin/node." >&2
  exit 1
fi

node_major="$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')"
if (( node_major < 20 )); then
  echo "Node.js 20 or newer is required; found $(/usr/bin/node --version)." >&2
  exit 1
fi

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${DATA_DIR}"
install -o root -g root -m 0644 \
  "${REPOSITORY_ROOT}/deploy/systemd/${SERVICE_NAME}" \
  "/etc/systemd/system/${SERVICE_NAME}"

if [[ ! -f /etc/default/sublim3-nexus ]]; then
  install -o root -g root -m 0644 \
    "${REPOSITORY_ROOT}/deploy/systemd/sublim3-nexus.default" \
    /etc/default/sublim3-nexus
fi

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo "SubLim3 Nexus Core is installed and running."
echo "Status: systemctl status ${SERVICE_NAME}"
echo "Logs:   journalctl -u ${SERVICE_NAME} -f"

