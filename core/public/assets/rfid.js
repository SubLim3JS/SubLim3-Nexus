const $ = (selector) => document.querySelector(selector);
const authToken = localStorage.getItem("nexus-admin-token") ?? localStorage.getItem("nexus-gm-token") ?? "";
let libraryItems = [];
let rfidCards = [];
let latestRfidScan = null;

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (authToken) headers.set("authorization", `Bearer ${authToken}`);
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 ? "Pair this browser as Admin or GM to manage RFID cards." : body.message ?? body.error ?? "Nexus request failed");
  return body.data;
}

function pageMessage(text = "", type = "") { $("#rfid-message").textContent = text; $("#rfid-message").className = `page-message ${type}`.trim(); }

function renderAudioOptions(selected = $("#rfid-audio-item").value) {
  const nodes = [];
  for (const [label, items] of [["Ambience", libraryItems.filter((item) => item.kind === "ambience")], ["Effects", libraryItems.filter((item) => item.kind === "effect")]]) {
    if (!items.length) continue;
    const group = document.createElement("optgroup"); group.label = label;
    for (const item of items) { const option = document.createElement("option"); option.value = item.item_id; option.textContent = item.name; option.selected = item.item_id === selected; group.append(option); }
    nodes.push(group);
  }
  $("#rfid-audio-item").replaceChildren(...nodes);
}

function actionLabel(card) {
  if (card.action.type === "audio") { const item = libraryItems.find((entry) => entry.item_id === card.action.item_id); return item ? `${item.kind === "effect" ? "Effect" : "Play"}: ${item.name}` : `Missing audio: ${card.action.item_id}`; }
  return { stop:"Stop playback", pause:"Pause playback", volume_up:"Volume up", volume_down:"Volume down" }[card.action.type] ?? card.action.type;
}

function updateActionField() { const audioAction = $("#rfid-action").value === "audio"; $("#rfid-audio-field").hidden = !audioAction; $("#rfid-audio-item").disabled = !audioAction; $("#rfid-audio-item").required = audioAction; }
function clearForm() { $("#rfid-form").reset(); $("#rfid-action").value = "audio"; updateActionField(); renderAudioOptions(); }
function editCard(card) { $("#rfid-uid").value = card.uid; $("#rfid-name").value = card.name; $("#rfid-action").value = card.action.type; updateActionField(); if (card.action.item_id) renderAudioOptions(card.action.item_id); $("#rfid-uid").focus(); window.scrollTo({ top:0, behavior:"smooth" }); }

function renderCards() {
  $("#rfid-count").textContent = `${rfidCards.length} card${rfidCards.length === 1 ? "" : "s"}`;
  if (!rfidCards.length) { const empty = document.createElement("p"); empty.className = "rfid-empty"; empty.textContent = "No cards assigned yet. Scan a card and create the first binding."; $("#rfid-card-list").replaceChildren(empty); return; }
  $("#rfid-card-list").replaceChildren(...rfidCards.map((card) => {
    const row = document.createElement("article"); row.className = "rfid-row";
    const identity = document.createElement("span"); const name = document.createElement("strong"); name.textContent = card.name; const uid = document.createElement("small"); uid.textContent = card.uid; identity.append(name, uid);
    const action = document.createElement("span"); action.className = "rfid-action-label"; action.textContent = actionLabel(card);
    const actions = document.createElement("span"); actions.className = "rfid-row-actions";
    for (const [label, handler, className] of [["Test", () => testUid(card.uid)], ["Edit", () => editCard(card)], ["Delete", () => deleteCard(card), "danger"]]) { const button = document.createElement("button"); button.type = "button"; button.textContent = label; if (className) button.className = className; button.addEventListener("click", handler); actions.append(button); }
    row.append(identity, action, actions); return row;
  }));
}

async function reloadCards() { rfidCards = await api("/api/v1/rfid/cards"); renderCards(); }
function renderLastScan(scan) { if (!scan) return; latestRfidScan = scan; $("#rfid-last-scan").textContent = scan.uid; const cardName = scan.card?.name ? ` · ${scan.card.name}` : " · Unassigned card"; const outcomes = { executed:"Action executed", ignored_delay:"Repeat scan ignored", released:"Card removed", unassigned:"No binding assigned" }; $("#rfid-last-outcome").textContent = `${outcomes[scan.outcome] ?? scan.outcome}${cardName}`; }
async function refreshLastScan() { try { const scan = await api("/api/v1/rfid/last-scan"); if (scan?.scanned_at !== latestRfidScan?.scanned_at) renderLastScan(scan); } catch { /* Status polling stays quiet. */ } }
async function testUid(uid) { if (!uid.trim()) return pageMessage("Enter or scan a card UID first.", "error"); try { const result = await api("/api/v1/rfid/scan", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ uid }) }); renderLastScan(result); pageMessage(result.outcome === "unassigned" ? "That card is not assigned yet." : `Scan result: ${result.outcome.replaceAll("_", " ")}.`, result.outcome === "executed" ? "success" : ""); } catch (error) { pageMessage(error.message, "error"); } }
async function deleteCard(card) { if (!window.confirm(`Delete the binding for ${card.name}?`)) return; try { await api(`/api/v1/rfid/cards/${encodeURIComponent(card.uid)}`, { method:"DELETE" }); await reloadCards(); pageMessage(`${card.name} deleted.`, "success"); } catch (error) { pageMessage(error.message, "error"); } }

$("#rfid-action").addEventListener("change", updateActionField); $("#rfid-clear").addEventListener("click", clearForm); $("#rfid-use-scan").addEventListener("click", () => { if (!latestRfidScan) return pageMessage("No card has been scanned yet.", "error"); $("#rfid-uid").value = latestRfidScan.uid; if (latestRfidScan.card) editCard(latestRfidScan.card); else $("#rfid-name").focus(); }); $("#rfid-simulate").addEventListener("click", () => testUid($("#rfid-uid").value));
$("#rfid-form").addEventListener("submit", async (event) => { event.preventDefault(); const type = $("#rfid-action").value; const action = type === "audio" ? { type, item_id:$("#rfid-audio-item").value } : { type }; try { const saved = await api("/api/v1/rfid/cards", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ uid:$("#rfid-uid").value, name:$("#rfid-name").value, action }) }); await reloadCards(); clearForm(); pageMessage(`${saved.name} is ready to scan.`, "success"); } catch (error) { pageMessage(error.message, "error"); } });

async function initialize() { try { libraryItems = await api("/api/v1/audio/library"); renderAudioOptions(); await reloadCards(); await refreshLastScan(); setInterval(refreshLastScan, 1000); } catch (error) { pageMessage(error.message, "error"); } }
updateActionField(); initialize();
