const $ = (selector) => document.querySelector(selector);
let adminToken = localStorage.getItem("nexus-admin-token") ?? "";

function alertMessage(message, type = "") { const alert = $("#settings-alert"); alert.textContent = message; alert.className = `settings-alert ${type}`; }
function headers(json = false) { return { ...(json ? { "content-type": "application/json" } : {}), ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}) }; }
async function api(path, options = {}) { const response = await fetch(path, options); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.message || body.details?.join(". ") || body.error || "Request failed"); return body; }
function lockControls(locked) { document.querySelectorAll(".locked-control").forEach((element) => element.classList.toggle("is-locked", locked)); }

function renderStatus(status) {
  $("#wifi-mode").textContent = status.wifi.mode;
  $("#mode-badge").textContent = status.supported ? `${status.wifi.mode} mode` : "Unavailable";
  $("#wifi-ssid").textContent = status.wifi.ssid || status.wifi.connection || "Not connected";
  $("#wifi-address").textContent = status.wifi.addresses?.[0] || "No address";
  $("#bluetooth-state").textContent = status.bluetooth.available ? status.bluetooth.visible ? "Visible" : status.bluetooth.powered ? "Hidden" : "Powered off" : "Unavailable";
  $("#bluetooth-visible").checked = Boolean(status.bluetooth.visible);
  const devices = status.bluetooth.connected_devices ?? [];
  $("#bluetooth-devices").textContent = devices.length ? devices.map((device) => `${device.name} • ${device.address}`).join("\n") : "No connected devices";
  if (!status.supported) alertMessage("Connectivity controls are available when Nexus Core runs on Raspberry Pi.");
  else alertMessage("Connectivity status is current.", "success");
}

async function loadStatus() { const { data } = await api("/api/v1/connectivity/status", { headers: headers() }); renderStatus(data); }

$("#pin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const response = await fetch("/api/v1/auth/pair", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ role:"admin", pin:$("#settings-pin").value.trim(), device_name:"System Admin settings" }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || "Pairing failed");
    adminToken = body.token; localStorage.setItem("nexus-admin-token", adminToken);
    await loadStatus(); lockControls(false); alertMessage("Settings controls unlocked.", "success");
  }
  catch (error) { adminToken = ""; localStorage.removeItem("nexus-admin-token"); lockControls(true); alertMessage(error.message, "error"); }
});

$("#scan-wifi").addEventListener("click", async () => {
  alertMessage("Scanning for Wi-Fi networks…");
  try { const { data } = await api("/api/v1/connectivity/wifi/networks", { headers: headers() }); $("#wifi-networks").replaceChildren(...data.map((network) => { const option=document.createElement("option"); option.value=network.ssid; option.label=`${network.signal}% • ${network.security}`; return option; })); alertMessage(`Found ${data.length} networks. Choose one or type its SSID.`, "success"); }
  catch (error) { alertMessage(error.message, "error"); }
});

$("#local-mode").addEventListener("click", async () => {
  if (!confirm("Switch to Local Wi-Fi? This browser will disconnect while Nexus starts its own network.")) return;
  alertMessage("Switching to Local Wi-Fi. Reconnect to the SubLim3-Nexus network, then reopen this page.");
  try { await api("/api/v1/connectivity/wifi/mode", { method:"POST", headers:headers(true), body:JSON.stringify({ mode:"local" }) }); }
  catch { /* A dropped request is expected when the Wi-Fi radio changes mode. */ }
});

$("#home-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const ssid=$("#home-ssid").value;
  if (!confirm(`Connect Nexus to “${ssid}”? This browser will disconnect. If connection fails, Nexus restores Local Mode.`)) return;
  alertMessage(`Connecting to ${ssid}. Rejoin that network, then open sublim3-nexus.local:3000.`);
  try { await api("/api/v1/connectivity/wifi/mode", { method:"POST", headers:headers(true), body:JSON.stringify({ mode:"home", ssid, password:$("#home-password").value }) }); }
  catch { /* Network switching commonly closes the current request. */ }
});

$("#bluetooth-visible").addEventListener("change", async (event) => {
  event.target.disabled = true;
  try { await api("/api/v1/connectivity/bluetooth/visibility", { method:"POST", headers:headers(true), body:JSON.stringify({ visible:event.target.checked }) }); alertMessage(`Bluetooth visibility ${event.target.checked ? "enabled" : "disabled"}.`, "success"); }
  catch (error) { event.target.checked = !event.target.checked; alertMessage(error.message, "error"); }
  finally { event.target.disabled = false; }
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

$("#update-system").addEventListener("click", () => {
  if (!confirm("Install the latest SubLim3 Nexus version from GitHub? Nexus Core will restart when the update finishes.")) return;
  systemAction("update", "Downloading and installing the latest Nexus release…", "Update installed. Nexus Core is restarting; reload this page in a moment.");
});

$("#reboot-system").addEventListener("click", () => {
  if (!confirm("Reboot Nexus Core now? The table will be unavailable for a moment.")) return;
  systemAction("reboot", "Rebooting Nexus Core…", "Reboot requested. Reconnect in a moment.");
});

$("#shutdown-system").addEventListener("click", () => {
  if (!confirm("Shut down Nexus Core? You will need physical access to turn it back on.")) return;
  systemAction("shutdown", "Shutting down Nexus Core safely…", "Shutdown requested. It is safe to disconnect power after the Pi turns off.");
});

lockControls(!adminToken);
if (adminToken) { loadStatus().then(() => lockControls(false)).catch(() => { adminToken=""; localStorage.removeItem("nexus-admin-token"); lockControls(true); alertMessage("Enter the Admin PIN to unlock connectivity controls."); }); }
else alertMessage("Enter the Admin PIN to unlock connectivity controls.");
