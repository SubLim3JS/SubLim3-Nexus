const $ = (selector) => document.querySelector(selector);
let authToken = localStorage.getItem("nexus-admin-token") ?? "";
let currentAdminSessionId = "";
let currentGmPin = "";
let gmPinRevealed = false;
let gameSystems = new Map();
let currentCharacterSystem = null;
let selectedCharacterPreset = null;
let editingCharacterRecord = null;

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
    const error = new Error(body.details?.join(". ") || body.message || body.error || "Request failed");
    error.status = response.status;
    throw error;
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

async function loadGameSystems() {
  const { data:systems } = await request("/api/v1/systems");
  gameSystems = new Map(systems.map((system) => [system.system_id, system]));
  const selector = $("#system-id");
  const selected = selector.value;
  selector.replaceChildren(...systems.map((system) => new Option(`${system.name} • v${system.version}`, system.system_id)));
  selector.value = gameSystems.has(selected) ? selected : gameSystems.has("custom") ? "custom" : systems[0]?.system_id ?? "";
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

function templateInput(definition, value) {
  const label = document.createElement("label");
  const input = document.createElement("input");
  label.append(definition.label, input);
  input.dataset.fieldId = definition.field_id;
  input.dataset.fieldType = definition.type;
  input.type = definition.type === "boolean" ? "checkbox" : definition.type === "number" ? "number" : "text";
  if (definition.type === "boolean") input.checked = Boolean(value);
  else input.value = value ?? "";
  return label;
}

function selectPreset(preset, button) {
  selectedCharacterPreset = preset;
  document.querySelectorAll(".character-preset-button").forEach((item) => item.classList.toggle("selected", item === button));
  $("#character-preset-message").textContent = `${preset.label} selected • ${preset.resources.health.current} health • ${preset.fields.defense} defense`;
  if (!$("#character-name").value.trim()) {
    $("#character-name").value = preset.suggested_name;
    if (!$("#character-id").dataset.edited) $("#character-id").value = slugify(preset.suggested_name);
  }
}

function renderCharacterTemplate(system, character = null) {
  currentCharacterSystem = system ?? null;
  selectedCharacterPreset = null;
  const sheet = system?.character_sheet ?? { fields:[], resources:[], presets:[], conditions:[] };
  const quickStart = system?.pack?.experience === "quick_start" && sheet.presets.length > 0;
  $("#character-preset-panel").hidden = !quickStart;
  $("#character-template-editor").hidden = quickStart;
  $("#character-preset-list").replaceChildren(...sheet.presets.map((preset) => {
    const button=document.createElement("button"),icon=document.createElement("i"),copy=document.createElement("span"),title=document.createElement("strong"),detail=document.createElement("small");
    button.type="button";button.className="character-preset-button";icon.textContent=preset.archetype.slice(0,1);title.textContent=preset.archetype;detail.textContent=preset.presentation[0].toUpperCase()+preset.presentation.slice(1);copy.append(title,detail);button.append(icon,copy);button.addEventListener("click",()=>selectPreset(preset,button));return button;
  }));
  $("#character-preset-message").textContent = character ? `${character.fields?.role ?? "Hero"} template • rename or reassign the player as needed.` : "Choose one of the eight heroes.";

  const fieldNodes=[];
  let previousSection="";
  for(const field of sheet.fields){if(field.section!==previousSection){const heading=document.createElement("p");heading.className="template-section-title";heading.textContent=field.section;fieldNodes.push(heading);previousSection=field.section;}fieldNodes.push(templateInput(field,character?.fields?.[field.field_id]??field.default_value));}
  $("#character-template-fields").replaceChildren(...fieldNodes);
  $("#character-template-resources").replaceChildren(...sheet.resources.map((resource)=>{
    const wrapper=document.createElement("div"),heading=document.createElement("strong"),currentLabel=document.createElement("label"),maximumLabel=document.createElement("label"),current=document.createElement("input"),maximum=document.createElement("input"),saved=character?.resources?.[resource.resource_id];
    wrapper.className="template-resource";heading.textContent=resource.label;currentLabel.append("Current",current);maximumLabel.append("Maximum",maximum);current.type=maximum.type="number";current.dataset.resourceId=maximum.dataset.resourceId=resource.resource_id;current.dataset.resourceValue="current";maximum.dataset.resourceValue="maximum";current.value=saved?.current??resource.default_current;maximum.value=saved?.maximum??resource.default_maximum;wrapper.append(heading,currentLabel,maximumLabel);return wrapper;
  }));
  $("#character-conditions").placeholder = sheet.conditions.length ? sheet.conditions.slice(0,3).join(", ") : "Inspired, Hidden";
}

function resetCharacterForm() {
  editingCharacterId = null;
  editingCharacterRecord = null;
  $("#character-form").reset();
  $("#character-id").disabled = false;
  $("#character-id").dataset.edited = "";
  $("#character-form-eyebrow").textContent = "NEW CHARACTER";
  $("#character-form-title").textContent = "Add to the party";
  $("#cancel-character-edit").hidden = true;
  renderCharacterTemplate(currentCharacterSystem);
}

function editCharacter(character) {
  editingCharacterId = character.character_id;
  editingCharacterRecord = character;
  $("#character-name").value = character.character_name;
  $("#player-name").value = character.player_name;
  renderCharacterTemplate(currentCharacterSystem, character);
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
    currentCharacterSystem = null;
    renderCharacterTemplate(null);
    $("#character-template-summary").textContent = "Select a campaign to load its character-sheet template.";
    $("#character-count").textContent = "0 characters";
    list.replaceChildren(characterEmpty("Select a campaign", "Choose a world to manage its party."));
    return;
  }
  const campaign = (await request(`/api/v1/campaigns/${encodeURIComponent(campaignId)}`)).data;
  const system = gameSystems.get(campaign.system_id);
  currentCharacterSystem = system ?? null;
  if (!editingCharacterId) renderCharacterTemplate(currentCharacterSystem);
  $("#character-template-summary").textContent = system
    ? `${system.name} v${system.version} • ${system.character_sheet.fields.length} fields • ${system.character_sheet.resources.length} resources • ${system.character_sheet.pages.length} companion pages`
    : `Template ${campaign.system_id} is unavailable.`;
  const { data } = await request(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/characters`);
  $("#character-count").textContent = `${data.length} ${data.length === 1 ? "character" : "characters"}`;
  list.replaceChildren(...(data.length ? data.map(characterCard) : [characterEmpty("No characters—yet.", "Add the first hero, rival, or investigator to this campaign.")]));
}

function collectTemplateValues() {
  const quickStart = currentCharacterSystem?.pack?.experience === "quick_start";
  if (quickStart) {
    if (editingCharacterRecord) return { fields:{ ...editingCharacterRecord.fields }, resources:{ ...editingCharacterRecord.resources } };
    if (!selectedCharacterPreset) throw new Error("Choose a ready-made hero first.");
    return { fields:{ ...selectedCharacterPreset.fields }, resources:Object.fromEntries(Object.entries(selectedCharacterPreset.resources).map(([id,resource])=>[id,{ ...resource }])) };
  }
  const fields = { ...(editingCharacterRecord?.fields ?? {}) };
  document.querySelectorAll("#character-template-fields input[data-field-id]").forEach((input) => {
    fields[input.dataset.fieldId] = input.dataset.fieldType === "boolean" ? input.checked : input.dataset.fieldType === "number" ? Number(input.value) || 0 : input.value;
  });
  const resources = { ...(editingCharacterRecord?.resources ?? {}) };
  for (const definition of currentCharacterSystem?.character_sheet.resources ?? []) {
    const current = document.querySelector(`[data-resource-id="${definition.resource_id}"][data-resource-value="current"]`);
    const maximum = document.querySelector(`[data-resource-id="${definition.resource_id}"][data-resource-value="maximum"]`);
    resources[definition.resource_id] = { label:definition.label, current:Number(current?.value)||0, maximum:Math.max(0,Number(maximum?.value)||0) };
  }
  return { fields, resources };
}

$("#character-campaign").addEventListener("change", () => { editingCharacterId=null;editingCharacterRecord=null;loadCharacters().then(resetCharacterForm).catch((error) => { $("#character-message").textContent = error.message; }); });
$("#cancel-character-edit").addEventListener("click", resetCharacterForm);
$("#character-name").addEventListener("input", (event) => { const id = $("#character-id"); if (!id.dataset.edited && !editingCharacterId) id.value = slugify(event.target.value); });
$("#character-id").addEventListener("input", (event) => { event.target.dataset.edited = "true"; });
$("#character-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const campaignId = $("#character-campaign").value;
  const message = $("#character-message");
  if (!campaignId) { message.textContent = "Select a campaign first."; message.className = "form-message error"; return; }
  let templateValues;
  try { templateValues=collectTemplateValues(); }
  catch(error){message.textContent=error.message;message.className="form-message error";return;}
  const payload = {
    character_id: $("#character-id").value,
    character_name: $("#character-name").value,
    player_name: $("#player-name").value,
    fields: templateValues.fields,
    resources: templateValues.resources,
    trackers: editingCharacterRecord?.trackers ?? {},
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

function renderSession(session) {
  const active=session.battle.combatants[session.battle.turn_index];
  $("#battle-status").textContent=session.mode==="battle"?`Battle • Round ${session.battle.round}`:"Game mode";
  $("#session-mode-display").textContent=session.mode==="battle"?"Battle":"Game";
  $("#scene-title-display").textContent=session.scene.title||"No public scene";
  $("#scene-description-display").textContent=session.scene.description||"No public description.";
  $("#turn-display strong").textContent=active?.name??"Not in battle";
  $("#turn-display small").textContent=`Round ${session.battle.round}`;
  const rows=session.battle.combatants.map((combatant,index)=>{const row=document.createElement("li");const name=document.createElement("strong"),initiative=document.createElement("span");if(index===session.battle.turn_index)row.className="active";name.textContent=combatant.name;initiative.textContent=`Initiative ${combatant.initiative}`;row.append(name,initiative);return row;});
  if(!rows.length){const row=document.createElement("li");row.textContent="No active combatants.";rows.push(row);}
  $("#combatant-overview").replaceChildren(...rows);
}
async function loadSession() { const id=$("#session-campaign").value; $("#reset-session").disabled=!id; if(!id)return; const {data}=await request(`/api/v1/campaigns/${encodeURIComponent(id)}/session`); renderSession(data); }
$("#session-campaign").addEventListener("change",loadSession);
$("#reset-session").addEventListener("click",async()=>{const id=$("#session-campaign").value;if(!id||!window.confirm("Reset this session? This immediately clears the public scene, encounter, initiative, round, and current turn for every connected client."))return;const button=$("#reset-session"),message=$("#session-message");button.disabled=true;try{const{data}=await request(`/api/v1/campaigns/${encodeURIComponent(id)}/session/reset`,{method:"POST"});renderSession(data);message.textContent="Session reset.";message.className="form-message success";}catch(error){message.textContent=error.message;message.className="form-message error";}finally{button.disabled=false;}});

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

function accessSessionRow(session) {
  const row = document.createElement("article");
  row.className = "access-session-row";
  const identity = document.createElement("div");
  const device = document.createElement("strong");
  const role = document.createElement("small");
  const scope = document.createElement("div");
  const scopeLabel = document.createElement("span");
  const expiry = document.createElement("small");
  const revoke = document.createElement("button");
  device.textContent = session.device_name || "Browser";
  const roleBadge = document.createElement("span");
  roleBadge.className = "role-badge";
  roleBadge.textContent = session.role;
  role.append(roleBadge);
  scope.className = "access-session-scope";
  scopeLabel.textContent = session.role === "admin" ? "All system access" : session.role === "gm" ? `Campaign: ${session.campaign_id}` : `Character: ${session.character_id}`;
  expiry.textContent = `Expires ${new Intl.DateTimeFormat([], { dateStyle: "medium" }).format(new Date(session.expires_at))}`;
  revoke.type = "button";
  revoke.textContent = session.session_id === currentAdminSessionId ? "This browser" : "Revoke";
  revoke.disabled = session.session_id === currentAdminSessionId;
  if (!revoke.disabled) revoke.addEventListener("click", async () => {
    if (!window.confirm(`Revoke access for ${session.device_name || session.role}?`)) return;
    await request(`/api/v1/auth/sessions/${session.session_id}`, { method: "DELETE" });
    await loadAccessPanel();
  });
  identity.append(device, role); scope.append(scopeLabel, expiry); row.append(identity, scope, revoke);
  return row;
}

function renderGmPin() {
  $("#gm-pin-display").textContent = gmPinRevealed ? currentGmPin : "••••••";
  $("#gm-pin-reveal").textContent = gmPinRevealed ? "Hide" : "Reveal";
}

async function loadAccessPanel() {
  const [{ data: pairing }, { data: sessions }] = await Promise.all([request("/api/v1/auth/pairing"), request("/api/v1/auth/sessions")]);
  currentGmPin = pairing.gm_pin;
  renderGmPin();
  $("#session-count").textContent = `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`;
  const list = $("#access-session-list");
  if (sessions.length) list.replaceChildren(...sessions.map(accessSessionRow));
  else { const empty = document.createElement("p"); empty.className = "access-session-empty"; empty.textContent = "No paired clients."; list.replaceChildren(empty); }
}

$("#gm-pin-reveal").addEventListener("click", () => { gmPinRevealed = !gmPinRevealed; renderGmPin(); });
$("#refresh-sessions").addEventListener("click", () => loadAccessPanel().catch((error) => { $("#access-message").textContent = error.message; }));
$("#gm-pin-rotate").addEventListener("click", async () => {
  if (!window.confirm("Rotate the GM PIN? Every paired GM device will be revoked and must enter the new PIN.")) return;
  const message = $("#access-message");
  try {
    const { data } = await request("/api/v1/auth/gm-pin/rotate", { method: "POST" });
    currentGmPin = data.gm_pin; gmPinRevealed = true; renderGmPin();
    message.textContent = "GM PIN rotated. Existing GM devices were revoked."; message.className = "form-message success";
    await loadAccessPanel(); gmPinRevealed = true; renderGmPin();
  } catch (error) { message.textContent = error.message; message.className = "form-message error"; }
});

updateClock();
setInterval(updateClock, 30_000);

async function openAdminApp() {
  const { data } = await request("/api/v1/auth/me");
  if (data.role !== "admin") { const error = new Error("This browser is not paired for Owner access."); error.status = 403; throw error; }
  currentAdminSessionId = data.session_id;
  $("#admin-gate").hidden = true;
  $("#admin-app").hidden = false;
  try {
    await loadGameSystems();
    await Promise.all([loadSystemInfo(), loadCampaigns(), loadAccessPanel()]);
  } catch (error) {
    showMessage(`Console restored, but some data could not be loaded: ${error.message}`, "error");
  }
}

$("#admin-pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("#admin-pair-message");
  try {
    const response = await fetch("/api/v1/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "admin", pin: $("#admin-pin").value, device_name: "System Admin browser" }) });
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

if (authToken) openAdminApp().catch((error) => {
  if ([401, 403].includes(error.status)) { authToken = ""; localStorage.removeItem("nexus-admin-token"); }
  const message = $("#admin-pair-message");
  message.textContent = [401, 403].includes(error.status) ? "Owner access has expired. Use the recovery PIN to reconnect this browser." : `Nexus Core is temporarily unavailable: ${error.message}`;
  message.className = "form-message error";
  $("#admin-gate").hidden = false;
});
