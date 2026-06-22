const $ = (selector) => document.querySelector(selector);
let authToken = localStorage.getItem("nexus-admin-token") ?? "";

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
  const headers = new Headers(options?.headers);
  if (authToken) headers.set("authorization", `Bearer ${authToken}`);
  const response = await fetch(path, { ...options, headers });
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
  const selector = $("#session-campaign");
  const selected = selector.value;
  selector.replaceChildren(new Option("Select a campaign", ""), ...data.map((campaign) => new Option(campaign.name, campaign.campaign_id)));
  selector.value = selected;
  const characterSelector = $("#character-campaign");
  const selectedCharacterCampaign = characterSelector.value;
  characterSelector.replaceChildren(new Option("Select a campaign", ""), ...data.map((campaign) => new Option(campaign.name, campaign.campaign_id)));
  characterSelector.value = selectedCharacterCampaign && data.some((campaign) => campaign.campaign_id === selectedCharacterCampaign)
    ? selectedCharacterCampaign
    : data.find((campaign) => campaign.active)?.campaign_id ?? data[0]?.campaign_id ?? "";
  await loadCharacters();
}

let editingCharacterId = null;

function characterEmpty(title, copy) {
  const wrapper = document.createElement("div");
  wrapper.className = "character-empty";
  const glyph = document.createElement("span");
  glyph.textContent = "♙";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const description = document.createElement("p");
  description.textContent = copy;
  wrapper.append(glyph, heading, description);
  return wrapper;
}

function resourceLine(resource) {
  const wrapper = document.createElement("div");
  wrapper.className = "resource-line";
  const copy = document.createElement("div");
  copy.className = "resource-copy";
  const label = document.createElement("span");
  label.textContent = resource.label;
  const value = document.createElement("span");
  value.textContent = `${resource.current} / ${resource.maximum}`;
  const meter = document.createElement("div");
  meter.className = "resource-meter";
  const fill = document.createElement("i");
  fill.style.width = `${resource.maximum > 0 ? Math.max(0, Math.min(100, resource.current / resource.maximum * 100)) : 0}%`;
  copy.append(label, value);
  meter.append(fill);
  wrapper.append(copy, meter);
  return wrapper;
}

function resetCharacterForm() {
  editingCharacterId = null;
  $("#character-form").reset();
  $("#character-level").value = "1";
  $("#health-current").value = "10";
  $("#health-maximum").value = "10";
  $("#character-id").disabled = false;
  $("#character-id").dataset.edited = "";
  $("#character-form-eyebrow").textContent = "NEW CHARACTER";
  $("#character-form-title").textContent = "Add to the party";
  $("#cancel-character-edit").hidden = true;
}

function editCharacter(character) {
  editingCharacterId = character.character_id;
  $("#character-name").value = character.character_name;
  $("#player-name").value = character.player_name;
  $("#character-role").value = character.fields?.role ?? "";
  $("#character-level").value = character.fields?.level ?? "";
  $("#character-defense").value = character.fields?.defense ?? "";
  $("#health-current").value = character.resources?.health?.current ?? 0;
  $("#health-maximum").value = character.resources?.health?.maximum ?? 0;
  const secondary = Object.values(character.resources ?? {}).find((resource) => resource.resource_id !== "health");
  $("#resource-label").value = secondary?.label ?? "";
  $("#resource-values").value = secondary ? `${secondary.current} / ${secondary.maximum}` : "";
  $("#character-conditions").value = character.conditions.join(", ");
  $("#character-notes").value = character.public_notes;
  $("#character-id").value = character.character_id;
  $("#character-id").disabled = true;
  $("#character-form-eyebrow").textContent = "EDIT CHARACTER";
  $("#character-form-title").textContent = character.character_name;
  $("#cancel-character-edit").hidden = false;
  $("#character-form").scrollIntoView({ behavior: "smooth", block: "center" });
}

function characterCard(character) {
  const card = document.createElement("article");
  card.className = "character-card";
  const head = document.createElement("div");
  head.className = "character-card-head";
  const avatar = document.createElement("div");
  avatar.className = "character-avatar";
  avatar.textContent = character.character_name.slice(0, 2).toUpperCase();
  const identity = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = character.character_name;
  const meta = document.createElement("p");
  meta.className = "character-card-meta";
  meta.textContent = [character.player_name || "Unassigned", character.fields?.role, character.fields?.level ? `Level ${character.fields.level}` : ""].filter(Boolean).join(" • ");
  identity.append(title, meta);
  head.append(avatar, identity);
  card.append(head);
  const health = character.resources?.health;
  if (health) card.append(resourceLine(health));
  if (character.conditions.length) {
    const chips = document.createElement("div");
    chips.className = "condition-chips";
    for (const condition of character.conditions) { const chip = document.createElement("span"); chip.textContent = condition; chips.append(chip); }
    card.append(chips);
  }
  const actions = document.createElement("div");
  actions.className = "character-card-actions";
  const playerView = document.createElement("a");
  playerView.href = `/player/?campaign=${encodeURIComponent(character.campaign_id)}&character=${encodeURIComponent(character.character_id)}`;
  playerView.textContent = "Player view";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => editCharacter(character));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Delete";
  remove.addEventListener("click", async () => {
    if (!window.confirm(`Delete “${character.character_name}”?`)) return;
    await request(`/api/v1/campaigns/${encodeURIComponent(character.campaign_id)}/characters/${encodeURIComponent(character.character_id)}`, { method: "DELETE" });
    if (editingCharacterId === character.character_id) resetCharacterForm();
    await loadCharacters();
  });
  actions.append(playerView, edit, remove);
  card.append(actions);
  return card;
}

async function loadCharacters() {
  const campaignId = $("#character-campaign").value;
  const list = $("#character-list");
  if (!campaignId) {
    $("#character-count").textContent = "0 characters";
    list.replaceChildren(characterEmpty("Select a campaign", "Choose a world to manage its party."));
    return;
  }
  const { data } = await request(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/characters`);
  $("#character-count").textContent = `${data.length} ${data.length === 1 ? "character" : "characters"}`;
  list.replaceChildren(...(data.length ? data.map(characterCard) : [characterEmpty("No characters—yet.", "Add the first hero, rival, or investigator to this campaign.")]));
}

function parseResourceValues(value) {
  const [current, maximum] = value.split("/").map((part) => Number(part.trim()));
  return { current: Number.isFinite(current) ? current : 0, maximum: Number.isFinite(maximum) ? maximum : (Number.isFinite(current) ? current : 0) };
}

$("#character-campaign").addEventListener("change", () => { resetCharacterForm(); loadCharacters().catch((error) => { $("#character-message").textContent = error.message; }); });
$("#cancel-character-edit").addEventListener("click", resetCharacterForm);
$("#character-name").addEventListener("input", (event) => { const id = $("#character-id"); if (!id.dataset.edited && !editingCharacterId) id.value = slugify(event.target.value); });
$("#character-id").addEventListener("input", (event) => { event.target.dataset.edited = "true"; });
$("#character-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const campaignId = $("#character-campaign").value;
  const message = $("#character-message");
  if (!campaignId) { message.textContent = "Select a campaign first."; message.className = "form-message error"; return; }
  const resourceLabel = $("#resource-label").value.trim();
  const resources = { health: { label: "Health", current: Number($("#health-current").value), maximum: Number($("#health-maximum").value) } };
  if (resourceLabel) resources.secondary = { label: resourceLabel, ...parseResourceValues($("#resource-values").value) };
  const payload = {
    character_id: $("#character-id").value,
    character_name: $("#character-name").value,
    player_name: $("#player-name").value,
    fields: { role: $("#character-role").value, level: Number($("#character-level").value) || 0, defense: $("#character-defense").value },
    resources,
    conditions: $("#character-conditions").value.split(",").map((condition) => condition.trim()).filter(Boolean),
    public_notes: $("#character-notes").value,
  };
  const path = editingCharacterId
    ? `/api/v1/campaigns/${encodeURIComponent(campaignId)}/characters/${encodeURIComponent(editingCharacterId)}`
    : `/api/v1/campaigns/${encodeURIComponent(campaignId)}/characters`;
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await request(path, { method: editingCharacterId ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    resetCharacterForm();
    message.textContent = "Character saved.";
    message.className = "form-message success";
    await loadCharacters();
  } catch (error) { message.textContent = error.message; message.className = "form-message error"; }
  finally { button.disabled = false; }
});

function renderSession(session) { const active=session.battle.combatants[session.battle.turn_index]; $("#battle-status").textContent=session.mode==="battle"?`Battle • Round ${session.battle.round}`:"Game mode"; $("#turn-display strong").textContent=active?.name??"Not in battle"; $("#turn-display small").textContent=`Round ${session.battle.round}`; }
async function loadSession() { const id=$("#session-campaign").value; if(!id)return; const {data}=await request(`/api/v1/campaigns/${id}/session`); $("#session-mode").value=data.mode; $("#scene-title").value=data.scene.title; $("#scene-description").value=data.scene.description; $("#combatants").value=data.battle.combatants.map(c=>`${c.name}, ${c.initiative}`).join("\n"); renderSession(data); }
$("#session-campaign").addEventListener("change",loadSession);
$("#session-form").addEventListener("submit",async(event)=>{event.preventDefault();const id=$("#session-campaign").value;if(!id)return;const combatants=$("#combatants").value.split("\n").filter(Boolean).map((line,index)=>{const [name,initiative]=line.split(",");return{combatant_id:`combatant_${index+1}`,name:name.trim(),initiative:Number(initiative)||0};});const {data}=await request(`/api/v1/campaigns/${id}/session`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({mode:$("#session-mode").value,scene:{title:$("#scene-title").value,description:$("#scene-description").value},battle:{combatants}})});renderSession(data);$("#session-message").textContent="Session published.";});
$("#next-turn").addEventListener("click",async()=>{const id=$("#session-campaign").value;if(!id)return;const {data}=await request(`/api/v1/campaigns/${id}/battle/next`,{method:"POST"});renderSession(data);});

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

async function openAdminApp() {
  const { data } = await request("/api/v1/auth/me");
  if (data.role !== "admin") throw new Error("This browser is not paired for System Admin access.");
  $("#admin-gate").hidden = true;
  $("#admin-app").hidden = false;
  await Promise.all([loadSystemInfo(), loadCampaigns()]);
}

$("#admin-pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#admin-pair-message");
  try {
    const response = await fetch("/api/v1/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "admin", pin: $("#admin-pin").value }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || "Pairing failed");
    authToken = body.token;
    localStorage.setItem("nexus-admin-token", authToken);
    await openAdminApp();
  } catch (error) { message.textContent = error.message; message.className = "form-message error"; }
});

$("#admin-logout").addEventListener("click", async () => {
  try { await request("/api/v1/auth/session", { method: "DELETE" }); } catch { /* The local token is cleared either way. */ }
  localStorage.removeItem("nexus-admin-token");
  window.location.reload();
});

if (authToken) openAdminApp().catch(() => { authToken = ""; localStorage.removeItem("nexus-admin-token"); $("#admin-gate").hidden = false; });
