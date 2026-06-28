const $ = (selector) => document.querySelector(selector);
const adminToken = localStorage.getItem("nexus-admin-token") ?? "";

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (adminToken) headers.set("authorization", `Bearer ${adminToken}`);
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 401 ? "Unlock the Command Center as Owner to manage Audio Packs." : body?.message || body?.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return body;
}

function emptyCard() {
  const card = document.createElement("article");
  card.className = "system-card";
  card.innerHTML = `<div class="system-card-head"><div><h3>No audio packs found</h3><p>Connect or import the expansions repository, then refresh this page. Audio packs use <code>audio-packs/&lt;pack_id&gt;/files/</code> or <code>packs/&lt;pack_id&gt;/audio/</code>.</p></div><span class="role-badge">Empty</span></div>`;
  return card;
}

function packCard(pack) {
  const card = document.createElement("article");
  const head = document.createElement("div");
  const copy = document.createElement("div");
  const badge = document.createElement("span");
  const title = document.createElement("h3");
  const description = document.createElement("p");
  const stats = document.createElement("dl");
  const meta = document.createElement("div");
  const action = document.createElement("button");

  card.className = "system-card";
  head.className = "system-card-head";
  badge.className = "role-badge";
  badge.textContent = pack.installed ? "Installed" : "Optional";
  title.textContent = pack.name;
  description.textContent = pack.description || "No audio pack description.";

  const contentType = pack.content_type === "sound_effects" ? "Sound effects" : pack.content_type === "scene_audio" ? "Scene audio" : "Mixed audio";
  for (const [label, value] of [["Genre", pack.genre ?? "Any"], ["Scene", pack.scene ?? "Mixed"], ["Type", contentType], ["Files", pack.file_count], ["Installed", pack.installed_file_count ?? 0]]) {
    const wrapper = document.createElement("div");
    const term = document.createElement("dt");
    const definition = document.createElement("dd");
    term.textContent = label;
    definition.textContent = value;
    wrapper.append(term, definition);
    stats.append(wrapper);
  }

  meta.className = "pack-meta";
  for (const value of [
    pack.kind === "game_audio" ? "Game audio" : "Audio pack",
    contentType,
    pack.commerce?.label ?? pack.availability,
    pack.library_folder ? `Installs to ${pack.library_folder}` : null,
    ...(pack.mood ?? []).slice(0, 2),
    ...(pack.recommended_for ?? []).slice(0, 1),
  ]) {
    if (!value) continue;
    const chip = document.createElement("span");
    chip.textContent = value;
    meta.append(chip);
  }

  action.type = "button";
  action.className = pack.installed ? "pack-action remove" : "pack-action";
  action.textContent = pack.installed ? "Remove audio pack" : "Install free pack";
  action.addEventListener("click", () => togglePack(pack, action));

  copy.append(title, description);
  head.append(copy, badge);
  card.append(head, stats, meta, action);
  return card;
}

async function loadPacks() {
  const { data: packs } = await api("/api/v1/audio-packs");
  $("#audio-pack-count").textContent = `${packs.length} ${packs.length === 1 ? "pack" : "packs"}`;
  $("#audio-pack-list").replaceChildren(...(packs.length ? packs.map(packCard) : [emptyCard()]));
}

async function togglePack(pack, action) {
  const message = $("#audio-pack-message");
  if (pack.installed && !window.confirm(`Remove ${pack.name}? Its imported audio files will be removed from the managed library.`)) return;
  action.disabled = true;
  message.textContent = pack.installed ? `Removing ${pack.name}…` : `Installing ${pack.name}…`;
  try {
    const result = await api(`/api/v1/audio-packs/${encodeURIComponent(pack.pack_id)}${pack.installed ? "" : "/install"}`, { method: pack.installed ? "DELETE" : "POST" });
    const count = result?.data?.imported_count ?? result?.data?.removed_count ?? 0;
    message.textContent = pack.installed ? `${pack.name} removed (${count} files).` : `${pack.name} installed (${count} files) and ready in the Media Library.`;
    message.className = "form-message pack-message success";
    await loadPacks();
  } catch (error) {
    message.textContent = error.message;
    message.className = "form-message pack-message error";
    action.disabled = false;
  }
}

loadPacks().catch((error) => {
  $("#audio-pack-message").textContent = error.message;
  $("#audio-pack-message").className = "form-message pack-message error";
  $("#audio-pack-count").textContent = "Unavailable";
  if (!adminToken || [401, 403].includes(error.status)) setTimeout(() => { window.location.href = "/"; }, 1200);
});
