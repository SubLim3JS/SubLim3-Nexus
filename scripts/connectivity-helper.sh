#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

readonly CONFIG_FILE="/etc/default/sublim3-nexus"
readonly APP_DIR="/opt/sublim3-nexus"
readonly REPOSITORY_URL="https://github.com/SubLim3JS/SubLim3-Nexus.git"
[[ "${EUID}" -eq 0 ]] || { echo "Connectivity helper must run as root." >&2; exit 1; }
[[ -r "${CONFIG_FILE}" ]] && source "${CONFIG_FILE}"

WIFI_INTERFACE="${NEXUS_WIFI_INTERFACE:-wlan0}"
HOTSPOT_CONNECTION="${NEXUS_HOTSPOT_CONNECTION:-sublim3-hotspot}"
HOME_CONNECTION="${NEXUS_HOME_CONNECTION:-sublim3-home}"
HOTSPOT_SSID="${NEXUS_HOTSPOT_SSID:-SubLim3-Nexus}"
HOTSPOT_PASSWORD="${NEXUS_HOTSPOT_PASSWORD:-}"
WIFI_MODE="${NEXUS_WIFI_MODE:-local}"

valid_interface() { [[ "$1" =~ ^[a-zA-Z0-9_.:-]+$ ]]; }
valid_interface "${WIFI_INTERFACE}" || { echo "Invalid Wi-Fi interface." >&2; exit 2; }

git_as_repository_owner() {
  local repository_owner
  repository_owner="$(stat -c '%U' "${APP_DIR}")"
  [[ -n "${repository_owner}" ]] || { echo "Unable to determine the Nexus repository owner." >&2; exit 1; }
  if [[ "${repository_owner}" == "root" ]]; then
    git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" "$@"
  else
    runuser -u "${repository_owner}" -- git -C "${APP_DIR}" "$@"
  fi
}

set_wifi_mode() {
  local mode="$1"
  [[ "${mode}" == "local" || "${mode}" == "home" ]] || exit 2
  if grep -q '^NEXUS_WIFI_MODE=' "${CONFIG_FILE}"; then sed -i "s/^NEXUS_WIFI_MODE=.*/NEXUS_WIFI_MODE=${mode}/" "${CONFIG_FILE}"; else printf 'NEXUS_WIFI_MODE=%s\n' "${mode}" >> "${CONFIG_FILE}"; fi
  chown root:nexus "${CONFIG_FILE}"
  chmod 0640 "${CONFIG_FILE}"
}

start_hotspot() {
  [[ ${#HOTSPOT_SSID} -ge 1 && ${#HOTSPOT_SSID} -le 32 ]] || { echo "Hotspot SSID must be 1-32 characters." >&2; exit 2; }
  [[ ${#HOTSPOT_PASSWORD} -ge 8 && ${#HOTSPOT_PASSWORD} -le 63 ]] || { echo "Hotspot password must be 8-63 characters." >&2; exit 2; }
  nmcli connection delete "${HOTSPOT_CONNECTION}" >/dev/null 2>&1 || true
  nmcli device wifi hotspot ifname "${WIFI_INTERFACE}" con-name "${HOTSPOT_CONNECTION}" ssid "${HOTSPOT_SSID}" password "${HOTSPOT_PASSWORD}"
}

connect_home() {
  [[ $# -eq 1 ]] || { echo "wifi-home requires one SSID." >&2; exit 2; }
  local ssid="$1" password=""
  IFS= read -r password || true
  [[ ${#ssid} -ge 1 && ${#ssid} -le 32 && "$ssid" != -* && "$ssid" != *$'\n'* && "$ssid" != *$'\r'* && "$ssid" != *$'\t'* ]] || { echo "Invalid home SSID." >&2; exit 2; }
  [[ ${#password} -le 64 && "$password" != *$'\n'* ]] || { echo "Invalid Wi-Fi password." >&2; exit 2; }
  set_wifi_mode home
  nmcli connection delete "${HOME_CONNECTION}" >/dev/null 2>&1 || true
  if [[ -n "${password}" ]]; then
    nmcli device wifi connect "${ssid}" password "${password}" ifname "${WIFI_INTERFACE}" name "${HOME_CONNECTION}" || { start_hotspot; exit 1; }
  else
    nmcli device wifi connect "${ssid}" ifname "${WIFI_INTERFACE}" name "${HOME_CONNECTION}" || { start_hotspot; exit 1; }
  fi
}

ensure_connected() {
  local state active_connection
  state="$(nmcli -g GENERAL.STATE device show "${WIFI_INTERFACE}" 2>/dev/null || true)"
  active_connection="$(nmcli -g GENERAL.CONNECTION device show "${WIFI_INTERFACE}" 2>/dev/null || true)"
  if [[ "${WIFI_MODE}" == "local" ]]; then
    [[ "${state}" == 100* && "${active_connection}" == "${HOTSPOT_CONNECTION}" ]] && exit 0
    start_hotspot
    exit 0
  fi
  [[ "${state}" == 100* && "${active_connection}" != "${HOTSPOT_CONNECTION}" ]] && exit 0
  if nmcli connection show "${HOME_CONNECTION}" >/dev/null 2>&1 && nmcli connection up "${HOME_CONNECTION}" >/dev/null 2>&1; then exit 0; fi
  start_hotspot
}

case "${1:-}" in
  wifi-local) [[ $# -eq 1 ]] || exit 2; set_wifi_mode local; start_hotspot ;;
  wifi-home) shift; connect_home "$@" ;;
  wifi-scan) [[ $# -eq 1 ]] || exit 2; nmcli -t --escape yes -f SSID,SIGNAL,SECURITY device wifi list ifname "${WIFI_INTERFACE}" --rescan yes ;;
  ensure-connected) [[ $# -eq 1 ]] || exit 2; ensure_connected ;;
  bluetooth-visible)
    [[ $# -eq 2 && ( "$2" == "on" || "$2" == "off" ) ]] || { echo "Visibility must be on or off." >&2; exit 2; }
    bluetoothctl power on >/dev/null
    bluetoothctl pairable "$2" >/dev/null
    bluetoothctl discoverable "$2" >/dev/null
    ;;
  gm-pin)
    [[ $# -eq 1 ]] || exit 2
    IFS= read -r new_pin || true
    [[ "${new_pin}" =~ ^[0-9]{6}$ ]] || { echo "GM PIN must be six digits." >&2; exit 2; }
    if grep -q '^NEXUS_GM_PIN=' "${CONFIG_FILE}"; then sed -i "s/^NEXUS_GM_PIN=.*/NEXUS_GM_PIN=${new_pin}/" "${CONFIG_FILE}"; else printf 'NEXUS_GM_PIN=%s\n' "${new_pin}" >> "${CONFIG_FILE}"; fi
    chown root:nexus "${CONFIG_FILE}"
    chmod 0640 "${CONFIG_FILE}"
    ;;
  system-shutdown)
    [[ $# -eq 1 ]] || exit 2
    systemctl poweroff
    ;;
  system-reboot)
    [[ $# -eq 1 ]] || exit 2
    systemctl reboot
    ;;
  system-update)
    [[ $# -eq 1 ]] || exit 2
    [[ -d "${APP_DIR}/.git" ]] || { echo "Nexus repository was not found at ${APP_DIR}." >&2; exit 1; }
    [[ -z "$(git_as_repository_owner status --porcelain)" ]] || { echo "Update refused because the Nexus installation has local changes." >&2; exit 1; }
    git_as_repository_owner fetch --quiet "${REPOSITORY_URL}" main
    git_as_repository_owner merge --ff-only FETCH_HEAD
    "${APP_DIR}/scripts/install.sh"
    ;;
  *) echo "Unsupported connectivity action." >&2; exit 2 ;;
esac
