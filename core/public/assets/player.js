const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(window.location.search);
const campaignId = params.get("campaign");
const characterId = params.get("character");

async function request(path) {
  const response = await fetch(path);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.message || body.error || "Request failed"); }
  return response.json();
}

function resourceRow(resource) {
  const row = document.createElement("div");
  const copy = document.createElement("div");
  copy.className = "player-resource-copy";
  const label = document.createElement("strong");
  label.textContent = resource.label;
  const value = document.createElement("span");
  value.textContent = `${resource.current} / ${resource.maximum}`;
  const meter = document.createElement("div");
  meter.className = "player-resource-meter";
  const fill = document.createElement("i");
  fill.style.width = `${resource.maximum > 0 ? Math.max(0, Math.min(100, resource.current / resource.maximum * 100)) : 0}%`;
  copy.append(label, value);
  meter.append(fill);
  row.append(copy, meter);
  return row;
}

function render(character, campaign, session) {
  document.title = `${character.character_name} • SubLim3 Nexus`;
  $("#campaign-name").textContent = campaign.name.toUpperCase();
  $("#character-name").textContent = character.character_name;
  $("#player-avatar").textContent = character.character_name.slice(0, 2).toUpperCase();
  $("#character-meta").textContent = [character.player_name, character.fields?.role, character.fields?.level ? `Level ${character.fields.level}` : ""].filter(Boolean).join(" • ") || "Ready for adventure";
  $("#defense-value").textContent = `Defense ${character.fields?.defense || "—"}`;
  const resources = Object.values(character.resources ?? {});
  $("#resource-list").replaceChildren(...(resources.length ? resources.map(resourceRow) : [resourceRow({ label: "No resources", current: 0, maximum: 0 })]));
  const conditions = character.conditions ?? [];
  const conditionNodes = conditions.map((condition) => { const chip = document.createElement("span"); chip.textContent = condition; return chip; });
  if (!conditionNodes.length) { const clear = document.createElement("span"); clear.className = "clear"; clear.textContent = "No active conditions"; conditionNodes.push(clear); }
  $("#condition-list").replaceChildren(...conditionNodes);
  $("#public-notes").textContent = character.public_notes || "No notes for this character.";
  $("#scene-title").textContent = session.scene?.title || "The table awaits";
  $("#scene-description").textContent = session.scene?.description || "The Game Master has not published a scene yet.";
  const active = session.battle?.combatants?.[session.battle.turn_index];
  $("#turn-name").textContent = active?.name ?? (session.mode === "battle" ? "Awaiting initiative" : "Exploration");
  $("#round-number").textContent = session.mode === "battle" ? `Round ${session.battle.round}` : "Game mode";
  $("#player-loading").hidden = true;
  $("#player-error").hidden = true;
  $("#player-content").hidden = false;
  $("#connection-state").classList.remove("offline");
  $("#connection-state").lastChild.textContent = "Connected";
}

async function refresh() {
  if (!campaignId || !characterId) throw new Error("This link needs both a campaign and character.");
  const encodedCampaign = encodeURIComponent(campaignId);
  const [campaign, character, session] = await Promise.all([
    request(`/api/v1/campaigns/${encodedCampaign}`),
    request(`/api/v1/campaigns/${encodedCampaign}/characters/${encodeURIComponent(characterId)}`),
    request(`/api/v1/campaigns/${encodedCampaign}/session`),
  ]);
  render(character.data, campaign.data, session.data);
}

function showError(error, initial = false) {
  if (initial) {
    $("#player-loading").hidden = true;
    $("#player-content").hidden = true;
    $("#player-error").hidden = false;
    $("#player-error-message").textContent = error.message;
  } else {
    $("#connection-state").classList.add("offline");
    $("#connection-state").lastChild.textContent = "Reconnecting";
  }
}

refresh().catch((error) => showError(error, true));
setInterval(() => refresh().catch((error) => showError(error)), 3_000);
