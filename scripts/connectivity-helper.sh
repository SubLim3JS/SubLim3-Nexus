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
HOTSPOT_ADDRESS="${NEXUS_HOTSPOT_ADDRESS:-10.10.10.1/24}"
WIFI_MODE="${NEXUS_WIFI_MODE:-local}"
HOME_RECONNECT_ATTEMPTS="${NEXUS_HOME_RECONNECT_ATTEMPTS:-12}"
HOME_RECONNECT_DELAY_SECONDS="${NEXUS_HOME_RECONNECT_DELAY_SECONDS:-5}"

valid_interface() { [[ "$1" =~ ^[a-zA-Z0-9_.:-]+$ ]]; }
valid_cidr() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || return 1
  local address="${1%/*}" prefix="${1#*/}" octet
  local -a octets
  (( prefix >= 1 && prefix <= 30 )) || return 1
  IFS=. read -r -a octets <<< "${address}"
  [[ ${#octets[@]} -eq 4 ]] || return 1
  for octet in "${octets[@]}"; do
    [[ "${octet}" =~ ^[0-9]+$ ]] || return 1
    (( octet >= 0 && octet <= 255 )) || return 1
  done
}
valid_positive_integer() { [[ "$1" =~ ^[0-9]+$ && "$1" -gt 0 ]]; }
valid_interface "${WIFI_INTERFACE}" || { echo "Invalid Wi-Fi interface." >&2; exit 2; }
valid_cidr "${HOTSPOT_ADDRESS}" || { echo "Invalid hotspot IPv4 address." >&2; exit 2; }
valid_positive_integer "${HOME_RECONNECT_ATTEMPTS}" || { echo "Invalid home Wi-Fi reconnect attempt count." >&2; exit 2; }
valid_positive_integer "${HOME_RECONNECT_DELAY_SECONDS}" || { echo "Invalid home Wi-Fi reconnect delay." >&2; exit 2; }

persist_config_permissions() {
  chown root:nexus "${CONFIG_FILE}"
  chmod 0640 "${CONFIG_FILE}"
}

quote_config_value() {
  local value="${1//\'/\'\\\'\'}"
  printf "'%s'" "${value}"
}

set_config_value() {
  local key="$1" value="$2" quoted_value escaped_value
  quoted_value="$(quote_config_value "${value}")"
  escaped_value="${quoted_value//\\/\\\\}"
  escaped_value="${escaped_value//&/\\&}"
  escaped_value="${escaped_value//|/\\|}"
  if grep -q "^${key}=" "${CONFIG_FILE}"; then
    sed -i "s|^${key}=.*|${key}=${escaped_value}|" "${CONFIG_FILE}"
  else
    printf '%s=%s\n' "${key}" "${quoted_value}" >> "${CONFIG_FILE}"
  fi
  persist_config_permissions
}

git_as_repository_owner() {
  local repository_owner
  repository_owner="$(stat -c '%U' "${APP_DIR}")"
  [[ -n "${repository_owner}" ]] || { echo "Unable to determine the Nexus repository owner." >&2; exit 1; }
  if [[ "${repository_owner}" == "root" ]]; then
    git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" "$@"
  else
    # Nexus Core runs with ProtectHome enabled. Give Git an accessible,
    # repository-local environment instead of probing the owner's hidden home.
    runuser -u "${repository_owner}" -- env \
      HOME="${APP_DIR}" \
      XDG_CONFIG_HOME="${APP_DIR}/.git/.config" \
      GIT_CONFIG_GLOBAL=/dev/null \
      git -C "${APP_DIR}" "$@"
  fi
}

set_wifi_mode() {
  local mode="$1"
  [[ "${mode}" == "local" || "${mode}" == "home" ]] || exit 2
  set_config_value NEXUS_WIFI_MODE "${mode}"
}

set_home_connection() {
  [[ -n "$1" && "$1" != "--" && "$1" != "${HOTSPOT_CONNECTION}" ]] || return 1
  HOME_CONNECTION="$1"
  set_config_value NEXUS_HOME_CONNECTION "${HOME_CONNECTION}"
}

restart_core() {
  systemctl restart --no-block sublim3-nexus.service >/dev/null 2>&1 || true
}

stop_hotspot() {
  nmcli connection down "${HOTSPOT_CONNECTION}" >/dev/null 2>&1 || true
  nmcli connection delete "${HOTSPOT_CONNECTION}" >/dev/null 2>&1 || true
}

disable_home_autoconnect() {
  local active_connection
  active_connection="$(nmcli -g GENERAL.CONNECTION device show "${WIFI_INTERFACE}" 2>/dev/null || true)"
  if [[ -n "${HOME_CONNECTION}" && "${HOME_CONNECTION}" != "--" && "${HOME_CONNECTION}" != "${HOTSPOT_CONNECTION}" ]]; then
    nmcli connection modify "${HOME_CONNECTION}" connection.autoconnect no >/dev/null 2>&1 || true
  fi
  if [[ -n "${active_connection}" && "${active_connection}" != "--" && "${active_connection}" != "${HOTSPOT_CONNECTION}" ]]; then
    nmcli connection modify "${active_connection}" connection.autoconnect no >/dev/null 2>&1 || true
    nmcli connection down "${active_connection}" >/dev/null 2>&1 || true
  fi
}

start_hotspot() {
  [[ ${#HOTSPOT_SSID} -ge 1 && ${#HOTSPOT_SSID} -le 32 ]] || { echo "Hotspot SSID must be 1-32 characters." >&2; exit 2; }
  [[ ${#HOTSPOT_PASSWORD} -ge 8 && ${#HOTSPOT_PASSWORD} -le 63 ]] || { echo "Hotspot password must be 8-63 characters." >&2; exit 2; }
  if [[ "${HOTSPOT_ADDRESS}" == "10.42.0.1/24" || "${HOTSPOT_ADDRESS}" == "10.99.0.1/24" ]]; then
    HOTSPOT_ADDRESS="10.10.10.1/24"
    set_config_value NEXUS_HOTSPOT_ADDRESS "${HOTSPOT_ADDRESS}"
  fi
  disable_home_autoconnect
  stop_hotspot
  nmcli radio wifi on >/dev/null
  nmcli device set "${WIFI_INTERFACE}" managed yes >/dev/null 2>&1 || true
  nmcli device wifi hotspot ifname "${WIFI_INTERFACE}" con-name "${HOTSPOT_CONNECTION}" ssid "${HOTSPOT_SSID}" password "${HOTSPOT_PASSWORD}"
  nmcli connection modify "${HOTSPOT_CONNECTION}" ipv4.method shared ipv4.addresses "${HOTSPOT_ADDRESS}"
  nmcli connection down "${HOTSPOT_CONNECTION}" >/dev/null 2>&1 || true
  nmcli connection up "${HOTSPOT_CONNECTION}" >/dev/null
}

restore_hotspot_after_home_failure() {
  echo "$1" >&2
  set_wifi_mode local
  start_hotspot
  restart_core
  exit 1
}

connect_home() {
  [[ $# -eq 1 ]] || { echo "wifi-home requires one SSID." >&2; exit 2; }
  local ssid="$1" password=""
  IFS= read -r password || true
  [[ ${#ssid} -ge 1 && ${#ssid} -le 32 && "$ssid" != -* && "$ssid" != *$'\n'* && "$ssid" != *$'\r'* && "$ssid" != *$'\t'* ]] || { echo "Invalid home SSID." >&2; exit 2; }
  [[ ${#password} -le 64 && "$password" != *$'\n'* ]] || { echo "Invalid Wi-Fi password." >&2; exit 2; }
  set_wifi_mode home
  stop_hotspot
  nmcli radio wifi on >/dev/null
  nmcli device set "${WIFI_INTERFACE}" managed yes >/dev/null 2>&1 || true
  nmcli device wifi rescan ifname "${WIFI_INTERFACE}" >/dev/null 2>&1 || true
  sleep 2
  nmcli connection down "${HOME_CONNECTION}" >/dev/null 2>&1 || true
  nmcli connection delete "${HOME_CONNECTION}" >/dev/null 2>&1 || true
  if [[ -n "${password}" ]]; then
    nmcli device wifi connect "${ssid}" password "${password}" ifname "${WIFI_INTERFACE}" name "${HOME_CONNECTION}" || restore_hotspot_after_home_failure "Unable to join home Wi-Fi. Restored Local Mode."
  else
    nmcli device wifi connect "${ssid}" ifname "${WIFI_INTERFACE}" name "${HOME_CONNECTION}" || restore_hotspot_after_home_failure "Unable to join open home Wi-Fi. Restored Local Mode."
  fi
  nmcli connection modify "${HOME_CONNECTION}" connection.autoconnect yes >/dev/null 2>&1 || true
  for _ in {1..20}; do
    local active_connection addresses
    active_connection="$(nmcli -g GENERAL.CONNECTION device show "${WIFI_INTERFACE}" 2>/dev/null || true)"
    addresses="$(nmcli -g IP4.ADDRESS device show "${WIFI_INTERFACE}" 2>/dev/null || true)"
    if [[ "${active_connection}" == "${HOME_CONNECTION}" && -n "${addresses}" ]]; then
      restart_core
      exit 0
    fi
    sleep 1
  done
  restore_hotspot_after_home_failure "Joined home Wi-Fi but did not receive an IPv4 address. Restored Local Mode."
}

ensure_connected() {
  local state active_connection attempt
  state="$(nmcli -g GENERAL.STATE device show "${WIFI_INTERFACE}" 2>/dev/null || true)"
  active_connection="$(nmcli -g GENERAL.CONNECTION device show "${WIFI_INTERFACE}" 2>/dev/null || true)"
  if [[ "${WIFI_MODE}" == "local" ]]; then
    [[ "${state}" == 100* && "${active_connection}" == "${HOTSPOT_CONNECTION}" ]] && exit 0
    start_hotspot
    exit 0
  fi
  if [[ "${state}" == 100* && -n "${active_connection}" && "${active_connection}" != "--" && "${active_connection}" != "${HOTSPOT_CONNECTION}" ]]; then
    [[ "${active_connection}" != "${HOME_CONNECTION}" ]] && set_home_connection "${active_connection}"
    exit 0
  fi
  nmcli radio wifi on >/dev/null
  nmcli device set "${WIFI_INTERFACE}" managed yes >/dev/null 2>&1 || true
  nmcli device wifi rescan ifname "${WIFI_INTERFACE}" >/dev/null 2>&1 || true
  if nmcli connection show "${HOME_CONNECTION}" >/dev/null 2>&1; then
    for (( attempt=1; attempt<=HOME_RECONNECT_ATTEMPTS; attempt++ )); do
      if nmcli connection up "${HOME_CONNECTION}" >/dev/null 2>&1; then exit 0; fi
      (( attempt < HOME_RECONNECT_ATTEMPTS )) && sleep "${HOME_RECONNECT_DELAY_SECONDS}"
    done
  fi
  set_wifi_mode local
  start_hotspot
}

diagnostic_ping() {
  [[ $# -eq 1 ]] || { echo "diagnostic-ping requires one target." >&2; exit 2; }
  local target="$1" output=""
  [[ ${#target} -ge 1 && ${#target} -le 253 && "$target" != -* && "$target" =~ ^[a-zA-Z0-9_.:-]+$ ]] || { echo "Invalid ping target." >&2; exit 2; }
  if output="$(ping -c 3 -W 2 "${target}" 2>&1)"; then
    printf '%s\n' "${output}"
  else
    local code=$?
    printf '%s\n' "${output}" >&2
    exit "${code}"
  fi
}

play_update_tone() {
  local result="$1" mpv_command="${NEXUS_MPV_PATH:-/usr/bin/mpv}" tone_file
  command -v python3 >/dev/null 2>&1 || return 0
  [[ -x "${mpv_command}" ]] || command -v mpv >/dev/null 2>&1 || return 0
  tone_file="$(mktemp /tmp/sublim3-nexus-update-tone.XXXXXX.wav)" || return 0
  python3 - "${result}" "${tone_file}" <<'PY' || { rm -f "${tone_file}"; return 0; }
import math
import struct
import sys
import wave

result, destination = sys.argv[1], sys.argv[2]
sample_rate = 44100
sequence = [(660, 0.16), (0, 0.04), (880, 0.22)] if result == "success" else [(220, 0.22), (0, 0.04), (185, 0.32)]
with wave.open(destination, "wb") as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(sample_rate)
    for frequency, duration in sequence:
        samples = max(1, int(sample_rate * duration))
        for index in range(samples):
            fade = min(1.0, index / 320, (samples - index - 1) / 320)
            sample = 0 if frequency == 0 else math.sin(2 * math.pi * frequency * index / sample_rate) * 0.35 * fade
            output.writeframes(struct.pack("<h", int(max(-1, min(1, sample)) * 32767)))
PY
  if [[ -x "${mpv_command}" ]]; then
    "${mpv_command}" --no-config --no-video --really-quiet --no-terminal --ao=alsa --volume=70 -- "${tone_file}" >/dev/null 2>&1 || true
  else
    mpv --no-config --no-video --really-quiet --no-terminal --ao=alsa --volume=70 -- "${tone_file}" >/dev/null 2>&1 || true
  fi
  rm -f "${tone_file}"
}

run_system_update() {
  [[ -d "${APP_DIR}/.git" ]] || { echo "Nexus repository was not found at ${APP_DIR}." >&2; return 1; }
  [[ -z "$(git_as_repository_owner status --porcelain)" ]] || { echo "Update refused because the Nexus installation has local changes." >&2; return 1; }
  git_as_repository_owner fetch --quiet "${REPOSITORY_URL}" main
  git_as_repository_owner merge --ff-only FETCH_HEAD
  "${APP_DIR}/scripts/install.sh"
}

case "${1:-}" in
  wifi-local) [[ $# -eq 1 ]] || exit 2; set_wifi_mode local; start_hotspot; restart_core ;;
  wifi-home) shift; connect_home "$@" ;;
  wifi-scan) [[ $# -eq 1 ]] || exit 2; nmcli -t --escape yes -f SSID,SIGNAL,SECURITY device wifi list ifname "${WIFI_INTERFACE}" --rescan yes ;;
  diagnostic-ping) shift; diagnostic_ping "$@" ;;
  ensure-connected) [[ $# -eq 1 ]] || exit 2; ensure_connected ;;
  bluetooth-visible)
    [[ $# -eq 2 && ( "$2" == "on" || "$2" == "off" ) ]] || { echo "Visibility must be on or off." >&2; exit 2; }
    if [[ "$2" == "on" ]] && command -v rfkill >/dev/null 2>&1; then
      rfkill unblock bluetooth >/dev/null 2>&1 || true
    fi
    for attempt in 1 2 3 4 5; do
      bluetoothctl power on >/dev/null
      bluetoothctl show | grep -q '^.*Powered: yes' && break
      sleep 1
    done
    if ! bluetoothctl show | grep -q '^.*Powered: yes'; then
      echo "Bluetooth is blocked or unavailable. Check rfkill and adapter power state." >&2
      exit 1
    fi
    if [[ "$2" == "on" ]]; then
      bluetoothctl pairable-timeout 0 >/dev/null
      bluetoothctl discoverable-timeout 0 >/dev/null
    fi
    bluetoothctl pairable "$2" >/dev/null
    bluetoothctl discoverable "$2" >/dev/null
    for attempt in 1 2 3 4 5; do
      if [[ "$2" == "on" ]] && bluetoothctl show | grep -q '^.*Discoverable: yes'; then break; fi
      if [[ "$2" == "off" ]] && bluetoothctl show | grep -q '^.*Discoverable: no'; then break; fi
      sleep 1
    done
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
  system-tone)
    [[ $# -eq 2 && ( "$2" == "success" || "$2" == "failure" ) ]] || { echo "System tone must be success or failure." >&2; exit 2; }
    play_update_tone "$2"
    ;;
  system-update)
    [[ $# -eq 1 ]] || exit 2
    if run_system_update; then
      play_update_tone success
    else
      status=$?
      play_update_tone failure
      exit "${status}"
    fi
    ;;
  *) echo "Unsupported connectivity action." >&2; exit 2 ;;
esac
