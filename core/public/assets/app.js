const $ = (selector) => document.querySelector(selector);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(totalSeconds) {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.details?.join(". ") || body.message || body.error || "Request failed");
  }
  return response.status === 204 ? null : response.json();
}

async function loadSystemInfo() {
  const info = await request("/api/v1/system/info");
  $("#version").textContent = `v${info.version}`;
  $("#uptime").textContent = formatUptime(info.uptime_seconds);
  $("#runtime").textContent = info.node_version;
  $("#hostname").textContent = info.hostname;
  $("#sidebar-hostname").textContent = `${info.hostname}.local`;
  $("#platform").textContent = `${info.platform} • ${info.architecture}`;
  $("#storage-free").textContent = formatBytes(info.storage.free_bytes);
  $("#storage-total").textContent = `of ${formatBytes(info.storage.total_bytes)} total`;
  $("#memory-free").textContent = formatBytes(info.memory.free_bytes);
  $("#memory-total").textContent = `of ${formatBytes(info.memory.total_bytes)} total`;
}

function campaignRow(campaign) {
  const row = document.createElement("article");
  row.className = "campaign-row";
  const copy = document.createElement("div");
  const title = document.createElement("h3");
  const meta = document.createElement("p");
  const remove = document.createElement("button");
  title.textContent = campaign.name;
  meta.textContent = `${campaign.system_id} • ${campaign.active ? "Active" : "Ready"}`;
  remove.type = "button";
  remove.textContent = "Delete";
  remove.addEventListener("click", async () => {
    if (!window.confirm(`Delete “${campaign.name}”? This cannot be undone.`)) return;
    remove.disabled = true;
    try { await request(`/api/v1/campaigns/${encodeURIComponent(campaign.campaign_id)}`, { method: "DELETE" }); await loadCampaigns(); }
    catch (error) { showMessage(error.message, "error"); remove.disabled = false; }
  });
  copy.append(title, meta);
  row.append(copy, remove);
  return row;
}

function emptyCampaignState() {
  const wrapper = document.createElement("div");
  wrapper.className = "empty-state";
  const glyph = document.createElement("span");
  glyph.className = "empty-glyph";
  glyph.textContent = "◇";
  const title = document.createElement("h3");
  title.textContent = "No campaigns—yet.";
  const copy = document.createElement("p");
  copy.textContent = "Create your first world. The Nexus will keep it ready for the table.";
  wrapper.append(glyph, title, copy);
  return wrapper;
}

async function loadCampaigns() {
  const { data } = await request("/api/v1/campaigns");
  const list = $("#campaign-list");
  $("#campaign-count").textContent = `${data.length} ${data.length === 1 ? "campaign" : "campaigns"}`;
  list.replaceChildren(...(data.length ? data.map(campaignRow) : [emptyCampaignState()]));
}

function showMessage(message, type = "") {
  const element = $("#form-message");
  element.textContent = message;
  element.className = `form-message ${type}`;
}

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

$("#campaign-name").addEventListener("input", (event) => {
  const id = $("#campaign-id");
  if (!id.dataset.edited) id.value = slugify(event.target.value);
});
$("#campaign-id").addEventListener("input", (event) => { event.target.dataset.edited = "true"; });

$("#campaign-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  showMessage("Creating campaign…");
  try {
    await request("/api/v1/campaigns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ campaign_id: $("#campaign-id").value, name: $("#campaign-name").value, system_id: $("#system-id").value }),
    });
    form.reset();
    $("#campaign-id").dataset.edited = "";
    showMessage("Campaign created.", "success");
    await loadCampaigns();
  } catch (error) { showMessage(error.message, "error"); }
  finally { button.disabled = false; }
});

function updateClock() {
  const now = new Date();
  const hour = now.getHours();
  const period = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  $("#clock").textContent = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(now);
  $("#greeting").textContent = `Good ${period}, Game Master.`;
}

updateClock();
setInterval(updateClock, 30_000);
Promise.all([loadSystemInfo(), loadCampaigns()]).catch((error) => showMessage(`Core connection error: ${error.message}`, "error"));
