const $ = (selector) => document.querySelector(selector);
let gmToken = localStorage.getItem("nexus-gm-token") ?? "";
let campaignId = "";

async function api(path, options = {}, authenticated = true) {
  const headers = new Headers(options.headers);
  if (authenticated && gmToken) headers.set("authorization", `Bearer ${gmToken}`);
  const response = await fetch(path, { ...options, headers });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || body?.details?.join(". ") || body?.error || "Request failed");
  return body;
}

async function loadCampaignOptions() {
  const { data } = await api("/api/v1/discovery/campaigns", {}, false);
  $("#gm-campaign").replaceChildren(new Option("Choose a campaign", ""), ...data.map((campaign) => new Option(campaign.name, campaign.campaign_id)));
}

function renderSession(session) {
  $("#gm-mode").value = session.mode; $("#gm-scene-title").value = session.scene.title; $("#gm-scene-description").value = session.scene.description;
  $("#gm-combatants").value = session.battle.combatants.map((combatant) => `${combatant.name}, ${combatant.initiative}`).join("\n");
  const active = session.battle.combatants[session.battle.turn_index];
  $("#gm-turn").querySelector("strong").textContent = active?.name ?? "Exploration";
  $("#gm-turn").querySelector("small").textContent = session.mode === "battle" ? `Round ${session.battle.round}` : "Game mode";
  $("#gm-mode-badge").textContent = session.mode === "battle" ? `Battle • Round ${session.battle.round}` : "Game mode";
}

function characterRow(character) {
  const row=document.createElement("article"); row.className="gm-character-row";
  const top=document.createElement("div"), copy=document.createElement("div"), name=document.createElement("strong"), meta=document.createElement("small"), link=document.createElement("a");
  name.textContent=character.character_name; meta.textContent=[character.player_name,character.fields?.role].filter(Boolean).join(" • ")||"Unassigned";
  link.href=`/player/?campaign=${encodeURIComponent(campaignId)}&character=${encodeURIComponent(character.character_id)}`; link.textContent="Player view"; copy.append(name,meta); top.append(copy,link); row.append(top);
  const health=character.resources?.health; if(health){const meter=document.createElement("div"),fill=document.createElement("i");meter.className="gm-health";fill.style.width=`${health.maximum>0?Math.max(0,Math.min(100,health.current/health.maximum*100)):0}%`;meter.append(fill);row.append(meter);} return row;
}

async function openConsole() {
  const { data: identity } = await api("/api/v1/auth/me");
  if (identity.role !== "gm" || !identity.campaign_id) throw new Error("This is not a GM session.");
  campaignId = identity.campaign_id;
  const [{ data: campaign }, { data: session }, { data: characters }] = await Promise.all([api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}`),api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/session`),api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/characters`)]);
  $("#gm-campaign-name").textContent=campaign.name; renderSession(session); $("#gm-character-count").textContent=characters.length; $("#gm-character-list").replaceChildren(...characters.map(characterRow));
  $("#gm-gate").hidden=true; $("#gm-app").hidden=false;
}

$("#gm-pair-form").addEventListener("submit",async(event)=>{event.preventDefault();const message=$("#gm-pair-message");try{const body=await api("/api/v1/auth/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({role:"gm",pin:$("#gm-pin").value,campaign_id:$("#gm-campaign").value,device_name:"GM / DM browser"})},false);gmToken=body.token;localStorage.setItem("nexus-gm-token",gmToken);await openConsole();}catch(error){message.textContent=error.message;message.className="form-message error";}});
$("#gm-session-form").addEventListener("submit",async(event)=>{event.preventDefault();const combatants=$("#gm-combatants").value.split("\n").filter(Boolean).map((line,index)=>{const [name,initiative]=line.split(",");return{combatant_id:`combatant_${index+1}`,name:name.trim(),initiative:Number(initiative)||0};});try{const{data}=await api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/session`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({mode:$("#gm-mode").value,scene:{title:$("#gm-scene-title").value,description:$("#gm-scene-description").value},battle:{combatants}})});renderSession(data);$("#gm-message").textContent="Table updated.";}catch(error){$("#gm-message").textContent=error.message;}});
$("#gm-next-turn").addEventListener("click",async()=>{try{const{data}=await api(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/battle/next`,{method:"POST"});renderSession(data);}catch(error){$("#gm-message").textContent=error.message;}});
$("#gm-logout").addEventListener("click",async()=>{try{await api("/api/v1/auth/session",{method:"DELETE"});}catch{}localStorage.removeItem("nexus-gm-token");window.location.reload();});

loadCampaignOptions().catch((error)=>{$("#gm-pair-message").textContent=error.message;});
if(gmToken)openConsole().catch(()=>{gmToken="";localStorage.removeItem("nexus-gm-token");});
