import { nexusConfirm } from "./dialogs.js";

const $ = (selector) => document.querySelector(selector);
const adminToken = localStorage.getItem("nexus-admin-token") ?? "";

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (adminToken) headers.set("authorization", `Bearer ${adminToken}`);
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(response.status === 401 ? "Unlock the Command Center as Admin to manage Player Controllers." : body?.message || body?.error || "Request failed"); error.status = response.status; throw error; }
  return body;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle:"medium", timeStyle:"short" }).format(date);
}

function renderControllers(sessions, campaigns, characters) {
  const campaignById = new Map(campaigns.map((campaign) => [campaign.campaign_id, campaign]));
  const characterById = new Map(characters.map((character) => [`${character.campaign_id}:${character.character_id}`, character]));
  const controllers = sessions.filter((session) => session.role === "player");
  $("#controller-count").textContent = controllers.length;
  $("#assignment-count").textContent = controllers.filter((session) => session.character_id).length;
  $("#controller-campaign-count").textContent = new Set(controllers.map((session) => session.campaign_id).filter(Boolean)).size;
  $("#controller-badge").textContent = `${controllers.length} paired`;
  if (!controllers.length) {
    const empty = document.createElement("article"); empty.className = "controller-empty";
    const icon = document.createElement("span"); icon.textContent = "⌁";
    const heading = document.createElement("h3"); heading.textContent = "No Player Controllers paired";
    const copy = document.createElement("p"); copy.textContent = "Pair a Player Cube or Player device and its character assignment will appear here.";
    empty.append(icon, heading, copy); $("#controller-list").replaceChildren(empty); return;
  }
  $("#controller-list").replaceChildren(...controllers.map((session) => {
    const campaign = campaignById.get(session.campaign_id); const character = characterById.get(`${session.campaign_id}:${session.character_id}`);
    const card = document.createElement("article"); card.className = "controller-card";
    const head = document.createElement("div"); head.className = "controller-card-head";
    const identity = document.createElement("div"); identity.className = "controller-identity";
    const icon = document.createElement("span"); icon.className = "controller-icon"; icon.textContent = "⌁";
    const copy = document.createElement("span"); const name = document.createElement("strong"); const type = document.createElement("small");
    name.textContent = session.device_name || "Player Controller"; type.textContent = /cube|controller|lilygo|esp32/i.test(session.device_name) ? "Hardware controller" : "Player device"; copy.append(name, type); identity.append(icon, copy);
    const status = document.createElement("span"); status.className = "controller-status"; status.textContent = "Paired"; head.append(identity, status);
    const assignment = document.createElement("div"); assignment.className = "controller-assignment";
    const campaignCell = document.createElement("div"); const campaignLabel = document.createElement("span"); const campaignName = document.createElement("strong"); campaignLabel.textContent = "Campaign"; campaignName.textContent = campaign?.name || session.campaign_id || "Unassigned"; campaignCell.append(campaignLabel, campaignName);
    const characterCell = document.createElement("div"); const characterLabel = document.createElement("span"); const characterName = document.createElement("strong"); characterLabel.textContent = "Character"; characterName.textContent = character?.character_name || session.character_id || "Unassigned"; characterCell.append(characterLabel, characterName); assignment.append(campaignCell, characterCell);
    const meta = document.createElement("p"); meta.className = "controller-meta"; meta.textContent = `Paired ${formatDate(session.created_at)} · Access expires ${formatDate(session.expires_at)}`;
    const revoke = document.createElement("button"); revoke.type = "button"; revoke.textContent = "Unpair controller"; revoke.addEventListener("click", () => unpairController(session));
    card.append(head, assignment, meta, revoke); return card;
  }));
}

async function loadControllers() {
  const [{ data:sessions }, { data:campaigns }] = await Promise.all([api("/api/v1/auth/sessions"), api("/api/v1/campaigns")]);
  const characterGroups = await Promise.all(campaigns.map((campaign) => api(`/api/v1/campaigns/${encodeURIComponent(campaign.campaign_id)}/characters`).then(({ data }) => data)));
  renderControllers(sessions, campaigns, characterGroups.flat());
  $("#controllers-message").textContent = "Player Controller roster is current."; $("#controllers-message").className = "controllers-message success";
}

async function unpairController(session) {
  if (!await nexusConfirm(`Unpair ${session.device_name || "this Player Controller"}?`, { detail:"It will need to pair again before it can sync.", okLabel:"Unpair" })) return;
  try { await api(`/api/v1/auth/sessions/${session.session_id}`, { method:"DELETE" }); await loadControllers(); }
  catch (error) { showError(error); }
}

function showError(error) { $("#controllers-message").textContent = error.message; $("#controllers-message").className = "controllers-message error"; if (!adminToken || error.status === 401) setTimeout(() => { window.location.href = "/"; }, 1200); }
$("#refresh-controllers").addEventListener("click", () => loadControllers().catch(showError));
loadControllers().catch(showError);
