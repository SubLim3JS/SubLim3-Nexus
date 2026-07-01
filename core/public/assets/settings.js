import { qrSvg } from "/assets/qr.js";
import { nexusConfirm } from "/assets/dialogs.js";

const $ = (selector) => document.querySelector(selector);
let adminToken = localStorage.getItem("nexus-admin-token") ?? "";
const UPDATE_NOTICE_KEY = "nexus-update-notice";
let updateProgressTimer = null;
let updateProgressStartedAt = 0;
let autoWifiScanStarted = false;
let bluetoothVisibilityPending = false;

function alertMessage(message, type = "") { const alert = $("#settings-alert"); alert.textContent = message; alert.className = `settings-alert ${type}`; }
function headers(json = false) { return { ...(json ? { "content-type": "application/json" } : {}), ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}) }; }
async function api(path, options = {}) { const response = await fetch(path, options); const body = await response.json().catch(() => ({})); if (!response.ok) { const error=new Error(body.message || body.details?.join(". ") || body.error || "Request failed");error.status=response.status;throw error; } return body; }
function lockControls(locked) { document.querySelectorAll(".locked-control").forEach((element) => element.classList.toggle("is-locked", locked)); }
function enablePlayerSettings(enabled) { document.querySelectorAll(".player-settings-panel input,.player-settings-panel select,.player-settings-panel button").forEach((element) => { element.disabled = !enabled; }); }
function devicePlatformName(){const ua=navigator.userAgent||"";const platform=/Android/i.test(ua)?"Android":/iPhone|iPad|iPod/i.test(ua)?"iOS":/Windows/i.test(ua)?"Windows":/Macintosh|Mac OS/i.test(ua)?"Mac":/Linux/i.test(ua)?"Linux":"Device";const browser=/Edg\//.test(ua)?"Edge":/Chrome|CriOS/.test(ua)?"Chrome":/Firefox|FxiOS/.test(ua)?"Firefox":/Safari/.test(ua)?"Safari":"Browser";return `${platform} ${browser}`;}
function devicePairingName(role="Owner"){const key="nexus-device-instance-id";let instance=localStorage.getItem(key);if(!instance){instance=Math.random().toString(16).slice(2,6).toUpperCase();localStorage.setItem(key,instance);}return `${role} · ${devicePlatformName()} · ${instance}`;}
const OWNER_APP_APK_URL = "https://github.com/SubLim3JS/SubLim3-Nexus/releases/latest/download/SubLim3_Nexus_Owner.apk";
const PLAYER_APP_APK_URL = "https://github.com/SubLim3JS/SubLim3-Nexus/releases/latest/download/SubLim3_Nexus_Player.apk";
function downloadUrl(value) { return new URL(value, window.location.origin).toString(); }
function renderAppInstallQrCodes(catalog = null) {
  const ownerQr = $("#owner-app-qr");
  const playerQr = $("#player-app-qr");
  const ownerUrl = downloadUrl(catalog?.apps?.owner?.apk ?? OWNER_APP_APK_URL);
  const playerUrl = downloadUrl(catalog?.apps?.player?.apk ?? PLAYER_APP_APK_URL);
  if (ownerQr) {
    try { ownerQr.innerHTML = qrSvg(ownerUrl, { title:"Install SubLim3 Nexus Owner/GM app" }); }
    catch { ownerQr.textContent = "QR unavailable"; }
  }
  if (playerQr) {
    try { playerQr.innerHTML = qrSvg(playerUrl, { title:"Install SubLim3 Nexus Player app" }); }
    catch { playerQr.textContent = "QR unavailable"; }
  }
  const ownerDownload = $("#owner-app-download");
  const playerDownload = $("#player-app-download");
  if (ownerDownload) ownerDownload.href = ownerUrl;
  if (playerDownload) playerDownload.href = playerUrl;
}

function saveUpdateNotice(message, type) { sessionStorage.setItem(UPDATE_NOTICE_KEY, JSON.stringify({ message, type })); }
function takeUpdateNotice() { try { const notice=JSON.parse(sessionStorage.getItem(UPDATE_NOTICE_KEY));sessionStorage.removeItem(UPDATE_NOTICE_KEY);return notice?.message?notice:null; } catch { sessionStorage.removeItem(UPDATE_NOTICE_KEY);return null; } }
function refreshSettingsPage(message, type) { saveUpdateNotice(message,type);window.location.replace(`/settings/?update=${Date.now()}`); }
async function waitForCore(timeoutMs=120_000) { const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){try{const response=await fetch("/api/v1/system/status",{cache:"no-store"});if(response.ok)return response.json();}catch{/* Restart in progress. */}await new Promise((resolve)=>setTimeout(resolve,1_000));}throw new Error("Nexus Core did not return before the update timeout."); }
async function playUpdateCue(result = "success") { await api("/api/v1/system/tone", { method:"POST", headers:headers(true), body:JSON.stringify({ result }) });await new Promise((resolve)=>setTimeout(resolve,result==="success"?650:850)); }
function updateDurationText() { const elapsed=Math.max(0,Math.floor((Date.now()-updateProgressStartedAt)/1000));return `${Math.floor(elapsed/60)}:${String(elapsed%60).padStart(2,"0")}`; }
function updateElapsedTime() { const elapsed=Math.max(0,Math.floor((Date.now()-updateProgressStartedAt)/1000));$("#update-progress-time").textContent=`${Math.floor(elapsed/60)}:${String(elapsed%60).padStart(2,"0")}`; }
function showUpdateProgress(stage, detail, state = "running") { const panel=$("#update-progress-panel");panel.hidden=false;panel.classList.toggle("is-complete",state==="complete");panel.classList.toggle("is-error",state==="error");$("#update-progress-stage").textContent=stage;$("#update-progress-detail").textContent=detail;updateElapsedTime(); }
function beginUpdateProgress() { updateProgressStartedAt=Date.now();clearInterval(updateProgressTimer);showUpdateProgress("Starting update…","Nexus is contacting the updater.");updateProgressTimer=setInterval(updateElapsedTime,1_000); }
function finishUpdateProgress(stage, detail, state) { clearInterval(updateProgressTimer);updateProgressTimer=null;showUpdateProgress(stage,detail,state); }
function confirmSettingsAction({ message, detail = "", okLabel = "OK" }) {
  return nexusConfirm(message, { detail, okLabel });
}

function renderWifiNetworks(networks) {
  $("#wifi-networks").replaceChildren(...networks.map((network) => {
    const option = document.createElement("option");
    option.value = network.ssid;
    option.label = `${network.signal}% - ${network.security}`;
    return option;
  }));
}

async function scanWifiNetworks({ automatic = false } = {}) {
  alertMessage(automatic ? "Local Mode detected. Scanning for Wi-Fi networks..." : "Scanning for Wi-Fi networks...");
  try {
    const { data } = await api("/api/v1/connectivity/wifi/networks", { headers: headers() });
    renderWifiNetworks(data);
    alertMessage(`Found ${data.length} networks. Choose one or type its SSID.`, "success");
  }
  catch (error) { alertMessage(error.message, "error"); }
}

function renderStatus(status) {
  const wifiMode = status.wifi.mode ? status.wifi.mode.charAt(0).toUpperCase() + status.wifi.mode.slice(1) : "Unknown";
  $("#wifi-mode").textContent = wifiMode;
  $("#mode-badge").textContent = status.supported ? `${wifiMode} mode` : "Unavailable";
  $("#wifi-ssid").textContent = status.wifi.ssid || status.wifi.connection || "Not connected";
  $("#wifi-address").textContent = status.wifi.addresses?.[0] || "No address";
  $("#bluetooth-state").textContent = status.bluetooth.available ? status.bluetooth.blocked ? "Blocked" : status.bluetooth.visible ? "Visible" : status.bluetooth.powered ? "Hidden" : "Powered off" : "Unavailable";
  const bluetoothVisible = $("#bluetooth-visible");
  if (bluetoothVisible) {
    bluetoothVisible.checked = Boolean(status.bluetooth.visible);
    bluetoothVisible.disabled = bluetoothVisibilityPending || !adminToken || !status.bluetooth.available;
  }
  const devices = status.bluetooth.connected_devices ?? [];
  const bluetoothDevices = $("#bluetooth-devices");
  if (bluetoothDevices) bluetoothDevices.textContent = devices.length ? devices.map((device) => `${device.name} • ${device.address}`).join("\n") : "No connected devices";
  if (!status.supported) alertMessage("Connectivity controls are available when Nexus Core runs on Raspberry Pi.");
  else alertMessage("Connectivity status is current.", "success");
  if (status.supported && status.wifi.mode === "local" && !autoWifiScanStarted) {
    autoWifiScanStarted = true;
    scanWifiNetworks({ automatic: true });
  }
}

async function loadStatus() { const { data } = await api("/api/v1/connectivity/status", { headers: headers() }); renderStatus(data); }
async function waitForBluetoothVisibility(expected, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    try {
      const { data } = await api("/api/v1/connectivity/status", { headers: headers() });
      latest = data;
      renderStatus(data);
      if (!data.bluetooth.available || data.bluetooth.visible === expected) return data;
    } catch { /* Keep polling while the adapter settles. */ }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return latest;
}
function renderPlayerSettings(settings) {
  $("#maximum-volume").value = settings.maximum_volume;
  $("#startup-volume").value = settings.startup_volume;
  $("#volume-step").value = settings.volume_step;
  $("#stop-playout-minutes").value = settings.stop_playout_minutes;
  $("#rfid-scan-mode").value = settings.rfid_scan_mode;
  $("#rfid-second-scan").value = settings.rfid_second_scan;
  $("#rfid-rescan-delay").value = settings.rfid_rescan_delay_seconds;
  $("#function-cards-bypass").checked = settings.function_cards_bypass_delay;
}
async function loadPlayerSettings() { const { data } = await api("/api/v1/settings/player", { headers:headers() }); renderPlayerSettings(data); }
async function loadAppUpdateInfo() {
  const panel = $("#app-update-status");
  if (!panel) return;
  try {
    const response = await fetch("/downloads/android-apps.json", { cache:"no-store" });
    if (!response.ok) throw new Error("App download metadata is not available yet.");
    const catalog = await response.json();
    renderAppInstallQrCodes(catalog);
    const owner = catalog.apps?.owner;
    const player = catalog.apps?.player;
    let current = null;
    if (window.NexusAndroid?.getAppInfo) current = JSON.parse(window.NexusAndroid.getAppInfo());
    const ownerLine = owner ? `Owner/GM latest: <strong>v${owner.versionName}</strong>` : "Owner/GM APK unavailable";
    const playerLine = player ? `Player latest: <strong>v${player.versionName}</strong>` : "Player APK unavailable";
    const currentLine = current ? `Installed app shell: <strong>v${current.versionName}</strong>${owner && current.versionCode < owner.versionCode ? " — update available." : " — current."}` : "Open this page inside the Owner/GM app to compare the installed app shell version.";
    panel.innerHTML = `${currentLine}<br>${ownerLine}<br>${playerLine}`;
  } catch (error) {
    panel.textContent = error.message;
  }
}
async function loadSettingsPage() {
  await loadStatus();
  try { await loadPlayerSettings(); enablePlayerSettings(true); return true; }
  catch { enablePlayerSettings(false); return false; }
}

$("#pin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const response = await fetch("/api/v1/auth/pair", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ role:"admin", pin:$("#settings-pin").value.trim(), device_name:devicePairingName("Owner") }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || "Pairing failed");
    adminToken = body.token; localStorage.setItem("nexus-admin-token", adminToken);
    const playerSettingsAvailable = await loadSettingsPage(); lockControls(false);
    alertMessage(playerSettingsAvailable ? "Settings controls unlocked." : "Settings unlocked. Restart Nexus Core to enable the new player settings.", playerSettingsAvailable ? "success" : "");
  }
  catch (error) { adminToken = ""; localStorage.removeItem("nexus-admin-token"); lockControls(true); alertMessage(error.message, "error"); }
});

$("#scan-wifi").addEventListener("click", async () => {
  scanWifiNetworks();
});

$("#local-mode").addEventListener("click", async () => {
  const confirmed = await confirmSettingsAction({
    message: "Switch to Local Wi-Fi?",
    detail: "This device may disconnect while Nexus starts its recovery network. Reconnect to SubLim3-Nexus, then open http://10.10.10.1:3000/settings/.",
    okLabel: "Switch",
  });
  if (!confirmed) return;
  alertMessage("Switching to Local Wi-Fi. Reconnect to SubLim3-Nexus, then open http://10.10.10.1:3000/settings/.");
  try { await api("/api/v1/connectivity/wifi/mode", { method:"POST", headers:headers(true), body:JSON.stringify({ mode:"local" }) }); }
  catch (error) { if (!(error instanceof TypeError)) alertMessage(error.message, "error"); }
});

$("#home-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const ssid=$("#home-ssid").value;
  if (!await confirmSettingsAction({
    message: `Connect Nexus to “${ssid}”?`,
    detail: "This browser will disconnect. If connection fails, Nexus restores Local Mode.",
    okLabel: "Connect",
  })) return;
  alertMessage(`Connecting to ${ssid}. Rejoin that network, then open sublim3-nexus.local:3000.`);
  try { await api("/api/v1/connectivity/wifi/mode", { method:"POST", headers:headers(true), body:JSON.stringify({ mode:"home", ssid, password:$("#home-password").value }) }); }
  catch { /* Network switching commonly closes the current request. */ }
});

$("#bluetooth-visible").addEventListener("change", async (event) => {
  const desired = event.target.checked;
  bluetoothVisibilityPending = true;
  event.target.disabled = true;
  alertMessage(`Turning Bluetooth visibility ${desired ? "on" : "off"}...`);
  try {
    const result = await api("/api/v1/connectivity/bluetooth/visibility", { method:"POST", headers:headers(true), body:JSON.stringify({ visible:desired }) });
    if (result.data) renderStatus(result.data);
    if (result.data?.bluetooth?.visible !== desired) await waitForBluetoothVisibility(desired);
    const actual = $("#bluetooth-visible").checked;
    alertMessage(actual === desired ? `Bluetooth visibility ${desired ? "enabled" : "disabled"}.` : "Bluetooth command completed, but Nexus reported a different visibility state.", actual === desired ? "success" : "error");
  }
  catch (error) {
    event.target.checked = !desired;
    alertMessage(error.message, "error");
  }
  finally {
    bluetoothVisibilityPending = false;
    event.target.disabled = !adminToken;
    loadStatus().catch(() => {});
  }
});

$("#ping-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = $("#ping-target").value.trim();
  $("#ping-output").textContent = `Pinging ${target} from Nexus Core…`;
  try {
    const { data } = await api("/api/v1/connectivity/tools/ping", { method:"POST", headers:headers(true), body:JSON.stringify({ target }) });
    $("#ping-output").textContent = `${data.ok ? "Reachable" : "Not reachable"}: ${data.target}\n\n${data.output || "No output returned."}`;
    alertMessage(data.ok ? `${data.target} is reachable from Nexus.` : `${data.target} did not respond from Nexus.`, data.ok ? "success" : "error");
  } catch (error) {
    $("#ping-output").textContent = error.message;
    alertMessage(error.message, "error");
  }
});

$("#playback-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { data } = await api("/api/v1/settings/player", { method:"PUT", headers:headers(true), body:JSON.stringify({
      maximum_volume:Number($("#maximum-volume").value), startup_volume:Number($("#startup-volume").value),
      volume_step:Number($("#volume-step").value), stop_playout_minutes:Number($("#stop-playout-minutes").value),
    }) });
    renderPlayerSettings(data); alertMessage("Playback settings saved.", "success");
  } catch (error) { alertMessage(error.message, "error"); }
});

$("#rfid-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { data } = await api("/api/v1/settings/player", { method:"PUT", headers:headers(true), body:JSON.stringify({
      rfid_scan_mode:$("#rfid-scan-mode").value, rfid_second_scan:$("#rfid-second-scan").value,
      rfid_rescan_delay_seconds:Number($("#rfid-rescan-delay").value), function_cards_bypass_delay:$("#function-cards-bypass").checked,
    }) });
    renderPlayerSettings(data); alertMessage("RFID settings saved.", "success");
  } catch (error) { alertMessage(error.message, "error"); }
});

async function systemAction(action, pendingMessage, successMessage) {
  alertMessage(pendingMessage);
  document.querySelectorAll(".system-actions button").forEach((button) => { button.disabled = true; });
  try {
    await api(`/api/v1/system/${action}`, { method:"POST", headers:headers(true), body:"{}" });
    alertMessage(successMessage, "success");
  }
  catch (error) {
    if (error instanceof TypeError) alertMessage(successMessage, "success");
    else { alertMessage(error.message, "error"); document.querySelectorAll(".system-actions button").forEach((button) => { button.disabled = false; }); }
  }
}

async function updateSystem() {
  alertMessage("Downloading and installing the latest Nexus release…");
  beginUpdateProgress();
  document.querySelectorAll(".system-actions button").forEach((button) => { button.disabled=true; });
  let requestSucceeded=false;
  try { showUpdateProgress("Downloading and installing…","Please keep this page open while Nexus applies the update, checks dependencies, and refreshes services.");await api("/api/v1/system/update",{method:"POST",headers:headers(true),body:"{}"});requestSucceeded=true; }
  catch(error){
    if(!(error instanceof TypeError)){await playUpdateCue("failure").catch(()=>{});finishUpdateProgress("Update failed",error.message,"error");return refreshSettingsPage(`${error.message} Took ${updateDurationText()}.`,"error");}
  }
  try {
    showUpdateProgress("Restarting Nexus Core…","The update request finished. Waiting for the service to come back online.");
    const status=await waitForCore();
    await playUpdateCue("success").catch(()=>{});
    finishUpdateProgress("Update complete",`Nexus Core v${status.version} is online.`,"complete");
    refreshSettingsPage(`Update succeeded. Nexus Core v${status.version} is online. Took ${updateDurationText()}.`,"success");
  } catch(error) {
    finishUpdateProgress("Update status unknown",error.message,"error");
    refreshSettingsPage(`${requestSucceeded?`Update finished, but ${error.message}`:`The update connection closed and ${error.message}`} Took ${updateDurationText()}.`,"error");
  }
}

$("#update-system").addEventListener("click", async () => {
  const confirmed = await confirmSettingsAction({
    message: "Install the latest version of the SubLim3 Nexus?",
    detail: "Nexus Core will restart when the update finishes.",
    okLabel: "Update",
  });
  if (!confirmed) return;
  if (window.NexusAndroid?.startSystemUpdate) {
    window.NexusAndroid.startSystemUpdate(adminToken);
    return;
  }
  updateSystem();
});

$("#reboot-system").addEventListener("click", async () => {
  if (!await confirmSettingsAction({
    message: "Reboot Nexus Core now?",
    detail: "The table will be unavailable for a moment.",
    okLabel: "Reboot",
  })) return;
  if (window.NexusAndroid?.startSystemAction) {
    window.NexusAndroid.startSystemAction("reboot", adminToken);
    return;
  }
  systemAction("reboot", "Rebooting Nexus Core…", "Reboot requested. Reconnect in a moment.");
});

$("#shutdown-system").addEventListener("click", async () => {
  if (!await confirmSettingsAction({
    message: "Shut down Nexus Core?",
    detail: "You will need physical access to turn it back on.",
    okLabel: "Shut down",
  })) return;
  if (window.NexusAndroid?.startSystemAction) {
    window.NexusAndroid.startSystemAction("shutdown", adminToken);
    return;
  }
  systemAction("shutdown", "Shutting down Nexus Core safely…", "Shutdown requested. It is safe to disconnect power after the Pi turns off.");
});

const updateNotice=takeUpdateNotice();
history.scrollRestoration="manual";
lockControls(!adminToken);
renderAppInstallQrCodes();
loadAppUpdateInfo();
const initialization=adminToken
  ? loadSettingsPage().then((playerSettingsAvailable) => { lockControls(false);if(!playerSettingsAvailable)alertMessage("Settings unlocked. Restart Nexus Core to enable the new player settings."); }).catch((error) => { if([401,403].includes(error.status)){adminToken="";localStorage.removeItem("nexus-admin-token");alertMessage("Owner access has expired. Use the recovery PIN to reconnect this browser.");}else alertMessage(`Settings are temporarily unavailable: ${error.message}`,"error");lockControls(true); })
  : Promise.resolve(alertMessage("Use the recovery PIN to connect this browser as Owner."));
initialization.finally(()=>{if(updateNotice)alertMessage(updateNotice.message,updateNotice.type);window.scrollTo(0,0);});
