const $ = (selector) => document.querySelector(selector);
const adminToken = localStorage.getItem("nexus-admin-token") ?? "";

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (adminToken) headers.set("authorization", `Bearer ${adminToken}`);
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 401 ? "Unlock the Command Center as Owner to manage Expansion Packs." : body?.message || body?.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return body;
}

function packCard(pack) {
  const card=document.createElement("article"),head=document.createElement("div"),copy=document.createElement("div"),badge=document.createElement("span"),title=document.createElement("h3"),description=document.createElement("p"),stats=document.createElement("dl"),meta=document.createElement("div"),action=document.createElement("button");
  card.className="system-card";head.className="system-card-head";badge.className="role-badge";badge.textContent=pack.preinstalled?"Ready to play":pack.installed?"Installed":"Optional";title.textContent=pack.name;description.textContent=pack.description||"No pack description.";
  for(const [label,value] of [["Category",pack.category||"System"],["Complexity",pack.complexity||"Custom"],["Fields",pack.field_count],["Cube pages",pack.page_count]]){const wrapper=document.createElement("div"),term=document.createElement("dt"),definition=document.createElement("dd");term.textContent=label;definition.textContent=value;wrapper.append(term,definition);stats.append(wrapper);}
  meta.className="pack-meta";
  for(const value of [pack.commerce?.label||pack.availability,pack.experience==="quick_start"?"Quick start":"Advanced",...(pack.tags??[]).slice(0,2),...(pack.recommended_audio_packs??[]).slice(0,1).map((id)=>`Pairs with ${id}`)]){if(!value)continue;const chip=document.createElement("span");chip.textContent=value;meta.append(chip);}
  action.type="button";action.className=pack.installed&&!pack.preinstalled?"pack-action remove":"pack-action";action.textContent=pack.preinstalled?"Included and ready":pack.installed?"Remove pack":"Install free pack";action.disabled=pack.preinstalled;
  if(!pack.preinstalled)action.addEventListener("click",()=>togglePack(pack,action));
  copy.append(title,description);head.append(copy,badge);card.append(head,stats,meta,action);return card;
}

async function loadPacks() {
  const { data:packs } = await api("/api/v1/packs");
  $("#system-count").textContent = `${packs.length} ${packs.length === 1 ? "pack" : "packs"}`;
  $("#system-list").replaceChildren(...packs.map(packCard));
}

async function togglePack(pack, action) {
  const message=$("#system-message");
  if(pack.installed&&!window.confirm(`Remove ${pack.name}? Existing campaigns must be removed first.`))return;
  action.disabled=true;message.textContent=pack.installed?`Removing ${pack.name}…`:`Installing ${pack.name}…`;
  try {
    await api(`/api/v1/packs/${encodeURIComponent(pack.pack_id)}${pack.installed?"":"/install"}`,{method:pack.installed?"DELETE":"POST"});
    message.textContent=pack.installed?`${pack.name} removed.`:`${pack.name} installed and ready for new campaigns.`;message.className="form-message pack-message success";await loadPacks();
  } catch(error) {
    message.textContent=error.message==="pack_in_use"?`${pack.name} is used by a campaign and cannot be removed.`:error.message;message.className="form-message pack-message error";action.disabled=false;
  }
}

loadPacks().catch((error) => {
  $("#system-message").textContent = error.message;
  $("#system-message").className = "form-message pack-message error";
  if (!adminToken || [401, 403].includes(error.status)) setTimeout(() => { window.location.href = "/"; }, 1200);
});
