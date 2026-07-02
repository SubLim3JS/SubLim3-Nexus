#!/usr/bin/env bash
set -euo pipefail

readonly APP_DIR="/opt/sublim3-nexus"
readonly DATA_DIR="/var/lib/sublim3-nexus"
readonly EXPANSIONS_REPO_DEFAULT="https://github.com/SubLim3JS/SubLim3-Nexus-Expansions.git"
readonly EXPANSIONS_REF_DEFAULT="main"
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
for hardware_group in gpio spi; do
  if getent group "${hardware_group}" >/dev/null 2>&1; then
    usermod -a -G "${hardware_group}" "${SERVICE_USER}"
  fi
done

if ! command -v mpv >/dev/null 2>&1; then
  echo "Installing the Raspberry Pi audio driver (mpv)..."
  if command -v apt-get >/dev/null 2>&1 && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends mpv; then
    echo "mpv installed. Nexus Core will provide server-side audio output."
  else
    echo "Warning: mpv could not be installed. Nexus will keep using browser audio until mpv is available." >&2
  fi
fi

if ! command -v bluealsa >/dev/null 2>&1; then
  echo "Installing Bluetooth speaker audio support (BlueALSA)..."
  if command -v apt-get >/dev/null 2>&1 && apt-get update && apt-cache show bluez-alsa-utils >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bluez-alsa-utils; then
    echo "BlueALSA installed. Nexus can register Bluetooth speaker audio endpoints."
  else
    echo "Warning: BlueALSA could not be installed. Bluetooth speakers may pair briefly and disconnect until BlueALSA is available." >&2
  fi
fi

install_python_package() {
  local package="$1"
  if /usr/bin/python3 -c "import ${package}" >/dev/null 2>&1; then
    return 0
  fi
  if command -v pip3 >/dev/null 2>&1; then
    /usr/bin/python3 -m pip install --break-system-packages "${package}" || true
  fi
}

if grep -qi "Raspberry Pi" /proc/device-tree/model 2>/dev/null; then
  echo "Installing Raspberry Pi RFID and GPIO support..."
  if command -v apt-get >/dev/null 2>&1 && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-gpiozero python3-spidev python3-rpi.gpio python3-pip; then
    if apt-cache show python3-mfrc522 >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-mfrc522 || true
    else
      install_python_package mfrc522
    fi
    if command -v raspi-config >/dev/null 2>&1; then
      raspi-config nonint do_spi 0
    fi
  else
    echo "Warning: Raspberry Pi RFID/GPIO dependencies could not be installed." >&2
  fi
fi

install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${DATA_DIR}"
# Older installs may contain store directories created before the service user was
# introduced. Reconcile the entire data tree so Nexus Core can persist records.
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"
find "${DATA_DIR}" -type d -exec chmod 0750 {} +
find "${DATA_DIR}" -type f -exec chmod 0640 {} +

expansions_cache="${DATA_DIR}/expansions/repo-cache"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "$(dirname "${expansions_cache}")"
if [[ -d "${expansions_cache}/.git" ]]; then
  if runuser -u "${SERVICE_USER}" -- git -C "${expansions_cache}" remote set-url origin "${NEXUS_EXPANSIONS_REPO:-${EXPANSIONS_REPO_DEFAULT}}" \
    && runuser -u "${SERVICE_USER}" -- git -C "${expansions_cache}" fetch --depth 1 origin "${NEXUS_EXPANSIONS_REF:-${EXPANSIONS_REF_DEFAULT}}" \
    && runuser -u "${SERVICE_USER}" -- git -C "${expansions_cache}" checkout --detach FETCH_HEAD; then
    echo "Expansion audio catalog cache updated."
  else
    echo "Warning: expansion audio catalog cache could not be updated. Existing cache, if any, will remain available." >&2
  fi
else
  rm -rf "${expansions_cache}"
  if runuser -u "${SERVICE_USER}" -- git clone --depth 1 --branch "${NEXUS_EXPANSIONS_REF:-${EXPANSIONS_REF_DEFAULT}}" "${NEXUS_EXPANSIONS_REPO:-${EXPANSIONS_REPO_DEFAULT}}" "${expansions_cache}"; then
    echo "Expansion audio catalog cache installed."
  else
    echo "Warning: expansion audio catalog cache could not be installed. Audio Packs will appear after the expansion repository is available." >&2
  fi
fi

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

quote_setting_value() {
  local value="${1//\'/\'\\\'\'}"
  printf "'%s'" "${value}"
}

set_setting() {
  local key="$1" value="$2" quoted_value escaped_value
  quoted_value="$(quote_setting_value "${value}")"
  escaped_value="${quoted_value//\\/\\\\}"
  escaped_value="${escaped_value//&/\\&}"
  escaped_value="${escaped_value//|/\\|}"
  if grep -q "^${key}=" /etc/default/sublim3-nexus; then
    sed -i "s|^${key}=.*|${key}=${escaped_value}|" /etc/default/sublim3-nexus
  else
    printf '%s=%s\n' "${key}" "${quoted_value}" >> /etc/default/sublim3-nexus
  fi
}

replace_setting_if_value() {
  local key="$1" current_value="$2" new_value="$3"
  if grep -q "^${key}=${current_value}$" /etc/default/sublim3-nexus; then
    sed -i "s|^${key}=${current_value}$|${key}=${new_value}|" /etc/default/sublim3-nexus
  fi
}

adopt_active_home_connection() {
  local active_connection active_type
  active_connection="$(nmcli -g GENERAL.CONNECTION device show "${NEXUS_WIFI_INTERFACE:-wlan0}" 2>/dev/null || true)"
  [[ -n "${active_connection}" && "${active_connection}" != "--" && "${active_connection}" != "${NEXUS_HOTSPOT_CONNECTION:-sublim3-hotspot}" ]] || return 0
  active_type="$(nmcli -g connection.type connection show "${active_connection}" 2>/dev/null || true)"
  [[ "${active_type}" == "802-11-wireless" ]] || return 0
  set_setting NEXUS_HOME_CONNECTION "${active_connection}"
  set_setting NEXUS_WIFI_MODE home
}

generate_six_digit_pin() {
  local pin
  pin="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')"
  printf '%06d' "$((pin % 900000 + 100000))"
}

owner_pin="101010"
recovery_pin="$(generate_six_digit_pin)"
gm_pin="$(generate_six_digit_pin)"
hotspot_password="Nexus-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
replace_setting_if_value NEXUS_HOTSPOT_ADDRESS 10.99.0.1/24 10.10.10.1/24
replace_setting_if_value NEXUS_HOTSPOT_ADDRESS 10.42.0.1/24 10.10.10.1/24
replace_setting_if_value NEXUS_SETTINGS_PIN 101010 "${recovery_pin}"
replace_setting_if_value NEXUS_BLUETOOTH_AUDIO_DEVICE auto alsa/bluealsa
ensure_setting NEXUS_SETTINGS_PIN "${recovery_pin}"
ensure_setting NEXUS_ADMIN_PIN "${owner_pin}"
ensure_setting NEXUS_GM_PIN "${gm_pin}"
ensure_setting NEXUS_HOTSPOT_PASSWORD "${hotspot_password}"
ensure_setting NEXUS_WIFI_INTERFACE wlan0
ensure_setting NEXUS_HOTSPOT_CONNECTION sublim3-hotspot
ensure_setting NEXUS_HOME_CONNECTION sublim3-home
ensure_setting NEXUS_HOTSPOT_SSID SubLim3-Nexus
ensure_setting NEXUS_HOTSPOT_ADDRESS 10.10.10.1/24
ensure_setting NEXUS_WIFI_MODE local
ensure_setting NEXUS_HOME_RECONNECT_ATTEMPTS 12
ensure_setting NEXUS_HOME_RECONNECT_DELAY_SECONDS 5
ensure_setting NEXUS_BLUETOOTH_AUDIO_DEVICE alsa/bluealsa
ensure_setting NEXUS_HARDWARE_DRIVER auto
ensure_setting NEXUS_EXPANSIONS_REPO "${EXPANSIONS_REPO_DEFAULT}"
ensure_setting NEXUS_EXPANSIONS_REF "${EXPANSIONS_REF_DEFAULT}"
ensure_setting NEXUS_RFID_SPI_BUS 0
ensure_setting NEXUS_RFID_SPI_DEVICE 0
ensure_setting NEXUS_RFID_RESET_GPIO 25
ensure_setting NEXUS_RFID_IRQ_GPIO 24
ensure_setting NEXUS_BUTTON_DOWN_GPIO 15
ensure_setting NEXUS_BUTTON_UP_GPIO 5
adopt_active_home_connection
chown root:"${SERVICE_USER}" /etc/default/sublim3-nexus
chmod 0640 /etc/default/sublim3-nexus

cat > /etc/sudoers.d/sublim3-nexus-connectivity <<EOF
${SERVICE_USER} ALL=(root) NOPASSWD: ${CONNECTIVITY_HELPER} *
EOF
chmod 0440 /etc/sudoers.d/sublim3-nexus-connectivity
visudo -cf /etc/sudoers.d/sublim3-nexus-connectivity >/dev/null

systemctl daemon-reload
if systemctl list-unit-files bluealsa.service >/dev/null 2>&1; then
  systemctl enable --now bluealsa.service >/dev/null 2>&1 || true
fi
systemctl enable "${RECOVERY_SERVICE}"
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

echo "Wi-Fi SSID:       $(grep '^NEXUS_HOTSPOT_SSID=' /etc/default/sublim3-nexus | cut -d= -f2-)"
echo "Wi-Fi password:   $(grep '^NEXUS_HOTSPOT_PASSWORD=' /etc/default/sublim3-nexus | cut -d= -f2-)"
echo "Owner PIN:        $(grep '^NEXUS_ADMIN_PIN=' /etc/default/sublim3-nexus | cut -d= -f2-)"
echo "GM PIN:           $(grep '^NEXUS_GM_PIN=' /etc/default/sublim3-nexus | cut -d= -f2-)"
echo "Recovery PIN:     $(grep '^NEXUS_SETTINGS_PIN=' /etc/default/sublim3-nexus | cut -d= -f2-)"
