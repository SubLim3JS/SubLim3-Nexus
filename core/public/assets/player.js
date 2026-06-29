const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(window.location.search);
let campaignId = params.get("campaign") ?? "";
let characterId = params.get("character") ?? "";
let playerToken = localStorage.getItem("nexus-player-token") ?? "";
let refreshTimer;
let eventAbort;

async function api(path, options = {}, authenticated = true) {
  const headers = new Headers(options.headers);
  if (authenticated && playerToken) headers.set("authorization", `Bearer ${playerToken}`);
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || body?.details?.join(". ") || body?.error || "Request failed");
  return body;
}

function devicePlatformName() {
  const ua = navigator.userAgent || "";
  const platform = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iOS" : /Windows/i.test(ua) ? "Windows" : /Macintosh|Mac OS/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome|CriOS/.test(ua) ? "Chrome" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "Browser";
  return `${platform} ${browser}`;
}

function devicePairingName(role = "Player") {
  const key = "nexus-device-instance-id";
  let instance = localStorage.getItem(key);
  if (!instance) {
    instance = Math.random().toString(16).slice(2, 6).toUpperCase();
    localStorage.setItem(key, instance);
  }
  return `${role} · ${devicePlatformName()} · ${instance}`;
}

async function adjustHealth(delta) {
  await api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/characters/${encodeURIComponent(characterId)}/resources/health/adjust`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delta }),
  });
  await refresh();
}

function resourceRow(resource, resourceId = "") {
  const row = document.createElement("div");
  const copy = document.createElement("div");
  const label = document.createElement("strong");
  const value = document.createElement("span");
  const meter = document.createElement("div");
  const fill = document.createElement("i");
  copy.className = "player-resource-copy";
  label.textContent = resource.label;
  value.textContent = `${resource.current} / ${resource.maximum}`;
  meter.className = "player-resource-meter";
  fill.style.width = `${resource.maximum > 0 ? Math.max(0, Math.min(100, resource.current / resource.maximum * 100)) : 0}%`;
  copy.append(label, value); meter.append(fill); row.append(copy, meter);
  if (resourceId === "health") {
    const controls = document.createElement("form"), amount = document.createElement("input"), damage = document.createElement("button"), heal = document.createElement("button");
    controls.className = "player-health-controls";
    amount.type = "number"; amount.min = "1"; amount.max = String(Math.max(1, Number(resource.maximum) || 999)); amount.value = "1"; amount.inputMode = "numeric"; amount.setAttribute("aria-label", "Health amount");
    damage.type = "submit"; damage.className = "damage"; damage.textContent = "Damage";
    heal.type = "button"; heal.className = "heal"; heal.textContent = "Heal";
    controls.addEventListener("submit", async (event) => { event.preventDefault(); const value = Math.max(1, Number(amount.value) || 1); damage.disabled = heal.disabled = true; try { await adjustHealth(-value); } catch (error) { showReconnect(); } });
    heal.addEventListener("click", async () => { const value = Math.max(1, Number(amount.value) || 1); damage.disabled = heal.disabled = true; try { await adjustHealth(value); } catch (error) { showReconnect(); } });
    controls.append(amount, damage, heal); row.append(controls);
  }
  return row;
}

function comparisonMatches(left,operator,right) { if(operator==="lt")return left<right;if(operator==="eq")return left===right;if(operator==="gte")return left>=right;if(operator==="gt")return left>right;return left<=right; }

function playerTrackerCard(tracker) { const card=document.createElement("div"),head=document.createElement("div"),label=document.createElement("strong"),status=document.createElement("span"),marks=document.createElement("div"),successes=document.createElement("span"),failures=document.createElement("span");card.className=`player-tracker ${tracker.status}`;head.className="player-tracker-head";label.textContent=tracker.label;status.textContent=tracker.status;successes.textContent=`Success ${"●".repeat(tracker.successes)}${"○".repeat(Math.max(0,tracker.success_target-tracker.successes))}`;failures.textContent=`Failure ${"●".repeat(tracker.failures)}${"○".repeat(Math.max(0,tracker.failure_target-tracker.failures))}`;marks.className="player-tracker-marks";marks.append(successes,failures);head.append(label,status);card.append(head,marks);return card; }

function render(character, campaign, session) {
  document.title = `${character.character_name} • SubLim3 Nexus`;
  $("#campaign-name").textContent = campaign.name.toUpperCase();
  $("#character-name").textContent = character.character_name;
  $("#player-avatar").textContent = character.character_name.slice(0, 2).toUpperCase();
  $("#character-meta").textContent = [character.player_name, character.fields?.role, character.fields?.level ? `Level ${character.fields.level}` : ""].filter(Boolean).join(" • ") || "Ready for adventure";
  $("#defense-value").textContent = `Defense ${character.fields?.defense || "—"}`;
  const resources = Object.entries(character.resources ?? {});
  $("#resource-list").replaceChildren(...(resources.length ? resources.map(([resourceId, resource]) => resourceRow(resource, resourceId)) : [resourceRow({ label: "No resources", current: 0, maximum: 0 })]));
  const trackers=Object.values(character.trackers??{}).filter((tracker)=>{if(!tracker.visible_when)return true;const resource=character.resources?.[tracker.visible_when.resource_id];return resource&&comparisonMatches(Number(resource.current),tracker.visible_when.operator,Number(tracker.visible_when.value));});
  $("#tracker-list").replaceChildren(...trackers.map(playerTrackerCard));
  const conditions = (character.conditions ?? []).map((condition) => { const chip = document.createElement("span"); chip.textContent = condition; return chip; });
  if (!conditions.length) { const clear = document.createElement("span"); clear.className = "clear"; clear.textContent = "No active conditions"; conditions.push(clear); }
  $("#condition-list").replaceChildren(...conditions);
  $("#public-notes").textContent = character.public_notes || "No notes for this character.";
  $("#scene-title").textContent = session.scene?.title || "The table awaits";
  $("#scene-description").textContent = session.scene?.description || "The Game Master has not published a scene yet.";
  const active = session.battle?.combatants?.[session.battle.turn_index];
  const isMyTurn = active?.character_id === character.character_id;
  $("#turn-name").textContent = isMyTurn ? "Your turn" : active?.name ?? (session.mode === "battle" ? "Awaiting initiative" : "Exploration");
  $("#round-number").textContent = session.mode === "battle" ? `Round ${session.battle.round}` : "Game mode";
  $("#identity-panel").classList.toggle("my-turn", isMyTurn);
  $("#my-turn-banner").hidden = !isMyTurn;
  $("#player-loading").hidden = true; $("#player-select").hidden = true; $("#player-error").hidden = true; $("#player-content").hidden = false;
  $("#connection-state").hidden = false; $("#player-switch").hidden = false;
  $("#connection-state").classList.remove("offline"); $("#connection-state").lastChild.textContent = "Connected";
}

async function refresh() {
  const encodedCampaign = encodeURIComponent(campaignId);
  const [campaign, character, session] = await Promise.all([
    api(`/api/v1/campaigns/${encodedCampaign}`),
    api(`/api/v1/campaigns/${encodedCampaign}/characters/${encodeURIComponent(characterId)}`),
    api(`/api/v1/campaigns/${encodedCampaign}/session`),
  ]);
  render(character.data, campaign.data, session.data);
}

function startPolling() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => refresh().catch(showReconnect), 3_000);
}

async function connectLiveEvents() {
  eventAbort?.abort(); eventAbort = new AbortController();
  const response = await fetch(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/events`, { headers: { authorization: `Bearer ${playerToken}` }, signal: eventAbort.signal });
  if (!response.ok || !response.body) throw new Error("Live updates unavailable");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  while (true) {
    const { value, done } = await reader.read(); if (done) throw new Error("Live connection closed");
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n"); buffer = events.pop() ?? "";
    for (const event of events) if (event.includes("event: session")) await refresh();
  }
}

function startLiveUpdates() {
  clearInterval(refreshTimer);
  connectLiveEvents().catch((error) => {
    if (error.name === "AbortError") return;
    showReconnect(); startPolling();
    setTimeout(() => { clearInterval(refreshTimer); startLiveUpdates(); }, 10_000);
  });
}

async function pairPlayer() {
  const body = await api("/api/v1/auth/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "player", campaign_id: campaignId, character_id: characterId, device_name: devicePairingName("Player") }) }, false);
  playerToken = body.token; localStorage.setItem("nexus-player-token", playerToken);
  await refresh(); startLiveUpdates();
}

async function loadCharacters(campaign) {
  const selector = $("#player-character");
  if (!campaign) { selector.disabled = true; selector.replaceChildren(new Option("Choose a character", "")); return; }
  selector.disabled = true; selector.replaceChildren(new Option("Loading characters…", ""));
  const { data } = await api(`/api/v1/discovery/campaigns/${encodeURIComponent(campaign)}/characters`, {}, false);
  selector.replaceChildren(new Option("Choose a character", ""), ...data.map((character) => new Option(character.character_name, character.character_id)));
  selector.disabled = false;
}

async function showSelection() {
  $("#player-loading").hidden = true; $("#player-content").hidden = true; $("#player-error").hidden = true; $("#player-select").hidden = false;
  $("#connection-state").hidden = true; $("#player-switch").hidden = true;
  const { data } = await api("/api/v1/discovery/campaigns", {}, false);
  $("#player-campaign").replaceChildren(new Option("Choose a campaign", ""), ...data.map((campaign) => new Option(campaign.name, campaign.campaign_id)));
}

function showReconnect() { $("#connection-state").classList.add("offline"); $("#connection-state").lastChild.textContent = "Reconnecting"; }
function showError(error) { $("#player-loading").hidden = true; $("#player-content").hidden = true; $("#player-select").hidden = true; $("#player-error").hidden = false; $("#connection-state").hidden = true; $("#player-switch").hidden = true; $("#player-error-message").textContent = error.message; }

$("#player-campaign").addEventListener("change", (event) => loadCharacters(event.target.value).catch(showError));
$("#player-pair-form").addEventListener("submit", async (event) => {
  event.preventDefault(); campaignId = $("#player-campaign").value; characterId = $("#player-character").value;
  try { await pairPlayer(); history.replaceState(null, "", `/player/?campaign=${encodeURIComponent(campaignId)}&character=${encodeURIComponent(characterId)}`); }
  catch (error) { $("#player-pair-message").textContent = error.message; }
});
$("#player-switch").addEventListener("click", async () => {
  eventAbort?.abort(); try { await api("/api/v1/auth/session", { method: "DELETE" }); } catch { /* Clear the local session regardless. */ }
  localStorage.removeItem("nexus-player-token"); window.location.href = "/player/";
});

async function start() {
  if (campaignId && characterId) {
    if (playerToken) {
      try { const { data } = await api("/api/v1/auth/me"); if (data.role === "player" && data.campaign_id === campaignId && data.character_id === characterId) { await refresh(); startLiveUpdates(); return; } }
      catch { playerToken = ""; }
    }
    await pairPlayer(); return;
  }
  if (playerToken) {
    try { const { data } = await api("/api/v1/auth/me"); if (data.role === "player") { campaignId = data.campaign_id; characterId = data.character_id; await refresh(); startLiveUpdates(); return; } }
    catch { playerToken = ""; localStorage.removeItem("nexus-player-token"); }
  }
  await showSelection();
}

start().catch(showError);
