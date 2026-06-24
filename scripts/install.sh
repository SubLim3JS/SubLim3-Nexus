#!/usr/bin/env bash
set -euo pipefail

readonly APP_DIR="/opt/sublim3-nexus"
readonly DATA_DIR="/var/lib/sublim3-nexus"
readonly SERVICE_NAME="sublim3-nexus.service"
readonly SERVICE_USER="nexus"
readonly RECOVERY_SERVICE="sublim3-network-recovery.service"
readonly CONNECTIVITY_HELPER="/usr/local/libexec/sublim3-nexus-connectivity"
readonly REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo: sudo ./scripts/install.sh" >&2
  exit 1
fi

if [[ "${REPOSITORY_ROOT}" != "${APP_DIR}" ]]; then
  echo "Expected the repository at ${APP_DIR}; found ${REPOSITORY_ROOT}." >&2
  exit 1
fi

# Updates originate inside the deliberately read-only Nexus Core service
# sandbox. Ask the system manager to run the actual installation in a fresh
# root service so package files and systemd units can be replaced safely.
if [[ "${NEXUS_INSTALL_TRANSIENT:-0}" != "1" ]]; then
  command -v systemd-run >/dev/null 2>&1 || { echo "Required command not found: systemd-run" >&2; exit 1; }
  exec systemd-run --quiet --wait --pipe --collect \
    --unit=sublim3-nexus-install \
    /usr/bin/env NEXUS_INSTALL_TRANSIENT=1 "${REPOSITORY_ROOT}/scripts/install.sh"
fi

if [[ ! -x /usr/bin/node ]]; then
  echo "Node.js is not installed at /usr/bin/node." >&2
  exit 1
fi

for required_command in nmcli bluetoothctl visudo git runuser getent usermod; do
  command -v "${required_command}" >/dev/null 2>&1 || { echo "Required command not found: ${required_command}" >&2; exit 1; }
done

# Updates are initiated by a root-owned helper, but the repository may belong to
# the interactive installer account. Reconcile mixed ownership left by older
# updater versions before returning control to that account.
repository_owner="$(stat -c '%U' "${APP_DIR}")"
repository_group="$(stat -c '%G' "${APP_DIR}")"
chown -R "${repository_owner}:${repository_group}" "${APP_DIR}"

node_major="$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')"
if (( node_major < 20 )); then
  echo "Node.js 20 or newer is required; found $(/usr/bin/node --version)." >&2
  exit 1
fi

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

if getent group audio >/dev/null 2>&1; then
  usermod -a -G audio "${SERVICE_USER}"
fi

if ! command -v mpv >/dev/null 2>&1; then
  echo "Installing the Raspberry Pi audio driver (mpv)..."
  if command -v apt-get >/dev/null 2>&1 && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends mpv; then
    echo "mpv installed. Nexus Core will provide server-side audio output."
  else
    echo "Warning: mpv could not be installed. Nexus will keep using browser audio until mpv is available." >&2
  fi
fi

install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${DATA_DIR}"
# Older installs may contain store directories created before the service user was
# introduced. Reconcile the entire data tree so Nexus Core can persist records.
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"
find "${DATA_DIR}" -type d -exec chmod 0750 {} +
find "${DATA_DIR}" -type f -exec chmod 0640 {} +
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "${REPOSITORY_ROOT}/scripts/connectivity-helper.sh" "${CONNECTIVITY_HELPER}"
install -o root -g root -m 0644 \
  "${REPOSITORY_ROOT}/deploy/systemd/${SERVICE_NAME}" \
  "/etc/systemd/system/${SERVICE_NAME}"
install -o root -g root -m 0644 \
  "${REPOSITORY_ROOT}/deploy/systemd/${RECOVERY_SERVICE}" \
  "/etc/systemd/system/${RECOVERY_SERVICE}"

if [[ ! -f /etc/default/sublim3-nexus ]]; then
  install -o root -g root -m 0644 \
    "${REPOSITORY_ROOT}/deploy/systemd/sublim3-nexus.default" \
    /etc/default/sublim3-nexus
fi

ensure_setting() {
  local key="$1" value="$2"
  grep -q "^${key}=" /etc/default/sublim3-nexus || printf '%s=%s\n' "${key}" "${value}" >> /etc/default/sublim3-nexus
}

settings_pin="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
settings_pin="$((settings_pin % 900000 + 100000))"
gm_pin="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
gm_pin="$((gm_pin % 900000 + 100000))"
hotspot_password="Nexus-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
ensure_setting NEXUS_SETTINGS_PIN "${settings_pin}"
ensure_setting NEXUS_ADMIN_PIN "${settings_pin}"
ensure_setting NEXUS_GM_PIN "${gm_pin}"
ensure_setting NEXUS_HOTSPOT_PASSWORD "${hotspot_password}"
ensure_setting NEXUS_WIFI_INTERFACE wlan0
ensure_setting NEXUS_HOTSPOT_CONNECTION sublim3-hotspot
ensure_setting NEXUS_HOME_CONNECTION sublim3-home
ensure_setting NEXUS_HOTSPOT_SSID SubLim3-Nexus
ensure_setting NEXUS_WIFI_MODE local
chown root:"${SERVICE_USER}" /etc/default/sublim3-nexus
chmod 0640 /etc/default/sublim3-nexus

cat > /etc/sudoers.d/sublim3-nexus-connectivity <<EOF
${SERVICE_USER} ALL=(root) NOPASSWD: ${CONNECTIVITY_HELPER} *
EOF
chmod 0440 /etc/sudoers.d/sublim3-nexus-connectivity
visudo -cf /etc/sudoers.d/sublim3-nexus-connectivity >/dev/null

systemctl daemon-reload
systemctl enable "${RECOVERY_SERVICE}"
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo "SubLim3 Nexus Core is installed and running."
echo "Status: systemctl status ${SERVICE_NAME}"
echo "Logs:   journalctl -u ${SERVICE_NAME} -f"
echo "Admin PIN:    $(grep '^NEXUS_ADMIN_PIN=' /etc/default/sublim3-nexus | cut -d= -f2-)"
echo "GM PIN:       $(grep '^NEXUS_GM_PIN=' /etc/default/sublim3-nexus | cut -d= -f2-)"
echo "Local Wi-Fi:  $(grep '^NEXUS_HOTSPOT_SSID=' /etc/default/sublim3-nexus | cut -d= -f2-)"
echo "Wi-Fi key:    $(grep '^NEXUS_HOTSPOT_PASSWORD=' /etc/default/sublim3-nexus | cut -d= -f2-)"
