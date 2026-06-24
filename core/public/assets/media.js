const $ = (selector) => document.querySelector(selector);
const authToken = localStorage.getItem("nexus-admin-token") ?? localStorage.getItem("nexus-gm-token") ?? "";
const tracks = [];
let libraryItems = [];
let folders = [""];
let rfidCards = [];
let latestRfidScan = null;
let audioContext;
let fileAudio;
let masterGain;
let trackBus;
let activeNodes = [];
let pulseTimer;
let currentTrack = 0;
let isPlaying = false;
let renderedItemId = null;
let serverStatus = null;
let statusReceivedAt = 0;
let lastEffectEventId = null;
let firstStatus = true;
let volumeTimer;

function formatTime(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "--:--";
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function message(text = "", type = "") {
  $("#media-message").textContent = text;
  $("#media-message").className = `media-message ${type}`.trim();
}

function libraryMessage(text = "", type = "") {
  $("#library-message").textContent = text;
  $("#library-message").className = `library-message ${type}`.trim();
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (authToken) headers.set("authorization", `Bearer ${authToken}`);
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 ? "Pair this browser as Admin or GM to manage table media." : body.message ?? body.details?.join(", ") ?? body.error ?? "Nexus request failed");
  return body.data;
}

async function ensureAudio() {
  if (!audioContext) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error("Web Audio is not supported by this browser.");
    audioContext = new AudioContext();
    masterGain = audioContext.createGain();
    trackBus = audioContext.createGain();
    masterGain.gain.value = Number($("#master-volume").value) / 100;
    trackBus.gain.value = 0;
    trackBus.connect(masterGain);
    masterGain.connect(audioContext.destination);
  }
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
}

function stopNodes() {
  clearInterval(pulseTimer);
  pulseTimer = undefined;
  for (const node of activeNodes) {
    try { node.stop(); } catch { /* Node may already be stopped. */ }
    try { node.disconnect(); } catch { /* Ignore disconnected nodes. */ }
  }
  activeNodes = [];
  if (fileAudio) {
    fileAudio.pause();
    fileAudio.removeAttribute("src");
    fileAudio.load();
    fileAudio = null;
  }
  renderedItemId = null;
}

function addOscillator(frequency, wave, gainValue, destination = trackBus) {
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = wave;
  oscillator.frequency.value = frequency;
  gain.gain.value = gainValue;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  activeNodes.push(oscillator, gain);
  return gain;
}

function addNoise(track) {
  const buffer = audioContext.createBuffer(1, audioContext.sampleRate * 2, audioContext.sampleRate);
  const channel = buffer.getChannelData(0);
  let last = 0;
  for (let index = 0; index < channel.length; index += 1) {
    const white = Math.random() * 2 - 1;
    last = last * 0.985 + white * 0.015;
    channel[index] = last;
  }
  const source = audioContext.createBufferSource();
  const filter = audioContext.createBiquadFilter();
  const gain = audioContext.createGain();
  source.buffer = buffer;
  source.loop = true;
  filter.type = "lowpass";
  filter.frequency.value = track.synthesis.cutoff;
  gain.gain.value = track.synthesis.noise;
  source.connect(filter).connect(gain).connect(trackBus);
  source.start();
  activeNodes.push(source, filter, gain);
}

function playBattlePulse() {
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(76, now);
  oscillator.frequency.exponentialRampToValueAtTime(46, now + 0.16);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.19, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
  oscillator.connect(gain).connect(trackBus);
  oscillator.start(now);
  oscillator.stop(now + 0.32);
}

function buildTrack(track) {
  stopNodes();
  const synthesis = track.synthesis;
  synthesis.frequencies.forEach((frequency, index) => {
    const gain = addOscillator(frequency, synthesis.wave, synthesis.wave === "sawtooth" ? 0.012 : 0.032 / (index + 1));
    const lfo = audioContext.createOscillator();
    const lfoGain = audioContext.createGain();
    lfo.frequency.value = 0.035 + index * 0.017;
    lfoGain.gain.value = 0.006;
    lfo.connect(lfoGain).connect(gain.gain);
    lfo.start();
    activeNodes.push(lfo, lfoGain);
  });
  addNoise(track);
  if (synthesis.pulse) {
    playBattlePulse();
    pulseTimer = setInterval(playBattlePulse, synthesis.pulse * 1000);
  }
  renderedItemId = track.item_id;
}

function renderLibrary() {
  $("#track-count").textContent = `${tracks.length} tracks`;
  $("#queue-list").replaceChildren(...tracks.map((track, index) => {
    const button = document.createElement("button");
    button.className = "queue-track";
    button.type = "button";
    button.dataset.track = String(index);
    const number = document.createElement("span");
    number.className = "track-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const copy = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = track.name;
    const small = document.createElement("small");
    small.textContent = track.folder_path || track.tags?.join(" • ") || "Library root";
    copy.append(strong, small);
    const duration = document.createElement("em");
    duration.textContent = track.source?.type === "radio" ? "LIVE" : formatTime(track.duration_seconds);
    button.append(number, copy, duration);
    button.addEventListener("click", () => playTrack(index));
    return button;
  }));
}

function folderName(folder) {
  return folder || "Library root";
}

function folderOptions(selected = "") {
  return folders.map((folder) => {
    const option = document.createElement("option");
    option.value = folder;
    option.textContent = folderName(folder);
    option.selected = folder === selected;
    return option;
  });
}

function renderFolders() {
  const current = folders.includes($("#library-folder").value) ? $("#library-folder").value : "";
  $("#library-folder").replaceChildren(...folderOptions(current));
  renderManagedFiles();
}

function renderManagedFiles() {
  const currentFolder = $("#library-folder").value;
  const files = libraryItems.filter((item) => item.source?.type === "file" && (item.folder_path ?? "") === currentFolder);
  $("#file-count").textContent = `${libraryItems.filter((item) => item.source?.type === "file").length} files`;
  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "library-empty";
    empty.textContent = `No audio files in ${folderName(currentFolder)}.`;
    $("#managed-files").replaceChildren(empty);
    return;
  }
  $("#managed-files").replaceChildren(...files.map((item) => {
    const row = document.createElement("div");
    row.className = "managed-file";
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = item.name;
    const details = document.createElement("small");
    details.textContent = `${item.source.original_filename} • ${Math.max(1, Math.round(item.source.size_bytes / 1024))} KB`;
    copy.append(name, details);
    const target = document.createElement("select");
    target.setAttribute("aria-label", `Move ${item.name} to folder`);
    target.append(...folderOptions(item.folder_path ?? ""));
    const move = document.createElement("button");
    move.type = "button";
    move.textContent = "Move";
    move.addEventListener("click", () => moveFile(item.item_id, target.value));
    row.append(copy, target, move);
    return row;
  }));
}

function renderUsbFiles(files) {
  $("#usb-results").hidden = false;
  $("#usb-count").textContent = `${files.length} found`;
  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "library-empty";
    empty.textContent = "No supported audio files were found in the configured USB mount roots.";
    $("#usb-files").replaceChildren(empty);
    return;
  }
  $("#usb-files").replaceChildren(...files.map((file) => {
    const row = document.createElement("div");
    row.className = "usb-file";
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = file.name;
    const location = document.createElement("small");
    location.textContent = file.location;
    copy.append(name, location);
    const destination = document.createElement("span");
    destination.textContent = folderName($("#library-folder").value);
    const actions = document.createElement("span");
    actions.className = "usb-actions";
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "Play from USB";
    play.addEventListener("click", () => playFromUsb(file.source_path));
    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.textContent = "Import to library";
    importButton.addEventListener("click", () => importUsb(file.source_path));
    actions.append(play, importButton);
    row.append(copy, destination, actions);
    return row;
  }));
}

function renderTrack() {
  const track = tracks[currentTrack];
  if (!track) return;
  $("#track-title").textContent = track.name;
  const sourceLabel = track.source?.type === "radio" ? "Live stream" : track.source?.type === "file" ? folderName(track.folder_path) : track.loop ? "Seamless ambience" : "One shot";
  $("#track-subtitle").textContent = `${track.description} • ${sourceLabel}`;
  $("#duration").textContent = track.source?.type === "radio" ? "LIVE" : formatTime(track.duration_seconds);
  document.querySelectorAll(".queue-track").forEach((button) => button.classList.toggle("active", Number(button.dataset.track) === currentTrack));
}

function renderPlayback() {
  $("#now-playing").classList.toggle("is-playing", isPlaying);
  $("#play-track").textContent = isPlaying ? "Ⅱ" : "▶";
  $("#play-track").setAttribute("aria-label", isPlaying ? "Pause" : "Play");
}

async function renderAudioState(status, allowAudio = false) {
  let activeIndex = tracks.findIndex((track) => track.item_id === status.item_id);
  if (activeIndex < 0 && ["usb", "radio"].includes(status.item?.source?.type)) {
    if (status.item.source.type === "radio") {
      for (let index = tracks.length - 1; index >= 0; index -= 1) {
        if (tracks[index].source?.type === "radio") tracks.splice(index, 1);
      }
    }
    tracks.push({ ...status.item, transient: true });
    activeIndex = tracks.length - 1;
    renderLibrary();
  }
  if (activeIndex >= 0) currentTrack = activeIndex;
  isPlaying = status.state === "playing";
  $("#master-volume").value = String(status.volume);
  $("#volume-value").textContent = `${status.volume}%`;
  $("#output-name").textContent = status.output?.name ?? "Browser renderer";
  if (masterGain && audioContext) masterGain.gain.setTargetAtTime(status.volume / 100, audioContext.currentTime, 0.025);
  renderTrack();
  renderPlayback();

  if (status.state === "stopped") {
    stopNodes();
  } else if (["file", "usb", "radio"].includes(status.item?.source?.type) && (allowAudio || fileAudio || audioContext)) {
    if (renderedItemId !== status.item_id) {
      stopNodes();
      const contentUrl = status.item.source.type === "radio"
        ? status.item.source.stream_url
        : status.item.source.type === "usb"
          ? `/api/v1/audio/usb/${encodeURIComponent(status.item_id)}/content`
          : `/api/v1/audio/files/${encodeURIComponent(status.item_id)}/content`;
      fileAudio = new Audio(contentUrl);
      fileAudio.loop = Boolean(status.item.loop);
      fileAudio.volume = status.volume / 100;
      const loadedFile = fileAudio;
      const desiredPosition = status.position_seconds;
      fileAudio.addEventListener("loadedmetadata", () => {
        if (desiredPosition) loadedFile.currentTime = desiredPosition;
        if (Number.isFinite(loadedFile.duration)) {
          const track = tracks.find((candidate) => candidate.item_id === status.item_id);
          if (track) track.duration_seconds = loadedFile.duration;
          renderTrack();
        }
      });
      renderedItemId = status.item_id;
    }
    fileAudio.volume = status.volume / 100;
    if (status.state === "playing") fileAudio.play().catch(() => message("Playback is active. Tap its queue item once to enable audio in this browser."));
    else fileAudio.pause();
  } else if (status.item?.synthesis && (allowAudio || audioContext)) {
    try {
      await ensureAudio();
      if (renderedItemId !== status.item_id) buildTrack(status.item);
      trackBus.gain.setTargetAtTime(status.state === "playing" ? 1 : 0.0001, audioContext.currentTime, 0.04);
    } catch {
      message("Playback is active. Tap its queue item once to enable audio in this browser.");
    }
  }
}

async function applyStatus(status, { allowAudio = false } = {}) {
  serverStatus = status;
  statusReceivedAt = performance.now();
  const effectEventId = status.last_effect?.event_id ?? null;
  if (!firstStatus && effectEventId && effectEventId !== lastEffectEventId && (allowAudio || audioContext)) {
    try { await playEffect(status.last_effect.item_id); } catch { message("Tap a sound effect once to enable audio in this browser."); }
  }
  lastEffectEventId = effectEventId;
  firstStatus = false;
  await renderAudioState(status, allowAudio);
}

async function control(path, body = {}) {
  try {
    await ensureAudio();
    const status = await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    message("Nexus Core synced.", "success");
    await applyStatus(status, { allowAudio: true });
  } catch (error) {
    message(error.message, "error");
  }
}

function playTrack(index) {
  currentTrack = (index + tracks.length) % tracks.length;
  renderTrack();
  if (tracks[currentTrack].source?.type === "radio") return control("/api/v1/audio/radio/play", { name: tracks[currentTrack].name, url: tracks[currentTrack].source.stream_url });
  return control("/api/v1/audio/play", { item_id: tracks[currentTrack].item_id });
}

function playNoiseBurst({ duration, cutoff, gainValue }) {
  const length = Math.floor(audioContext.sampleRate * duration);
  const buffer = audioContext.createBuffer(1, length, audioContext.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) data[index] = (Math.random() * 2 - 1) * (1 - index / length);
  const source = audioContext.createBufferSource();
  const filter = audioContext.createBiquadFilter();
  const gain = audioContext.createGain();
  source.buffer = buffer;
  filter.frequency.value = cutoff;
  gain.gain.setValueAtTime(gainValue, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration);
  source.connect(filter).connect(gain).connect(masterGain);
  source.start();
}

async function playEffect(name) {
  await ensureAudio();
  const now = audioContext.currentTime;
  const tone = (type, from, to, duration, volume) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, now);
    oscillator.frequency.exponentialRampToValueAtTime(to, now + duration);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(masterGain);
    oscillator.start(now);
    oscillator.stop(now + duration);
  };
  if (name === "thunder") { tone("sine", 78, 28, 1.8, 0.38); playNoiseBurst({ duration: 2, cutoff: 180, gainValue: 0.32 }); }
  if (name === "ancient-door") { tone("sawtooth", 105, 42, 0.9, 0.16); playNoiseBurst({ duration: 0.7, cutoff: 420, gainValue: 0.12 }); }
  if (name === "blade-clash") { tone("square", 1200, 340, 0.28, 0.12); playNoiseBurst({ duration: 0.18, cutoff: 4200, gainValue: 0.09 }); }
  if (name === "arcane-pulse") { tone("sine", 330, 990, 1.15, 0.16); tone("triangle", 495, 1480, 0.95, 0.07); }
}

function updateProgress() {
  const track = tracks[currentTrack];
  if (track && serverStatus) {
    if (track.source?.type === "radio") {
      $("#elapsed").textContent = "LIVE";
      $("#progress-bar").style.width = isPlaying ? "100%" : "0%";
      requestAnimationFrame(updateProgress);
      return;
    }
    let elapsed = serverStatus.position_seconds;
    if (serverStatus.state === "playing") elapsed += (performance.now() - statusReceivedAt) / 1000;
    if (track.duration_seconds && track.loop) elapsed %= track.duration_seconds;
    else if (track.duration_seconds) elapsed = Math.min(elapsed, track.duration_seconds);
    $("#elapsed").textContent = formatTime(elapsed);
    $("#progress-bar").style.width = track.duration_seconds ? `${(elapsed / track.duration_seconds) * 100}%` : "0%";
  }
  requestAnimationFrame(updateProgress);
}

$("#play-track").addEventListener("click", () => isPlaying ? control("/api/v1/audio/pause") : playTrack(currentTrack));
$("#stop-track").addEventListener("click", () => control("/api/v1/audio/stop"));
$("#previous-track").addEventListener("click", () => playTrack(currentTrack - 1));
$("#next-track").addEventListener("click", () => playTrack(currentTrack + 1));
document.querySelectorAll("[data-sfx]").forEach((button) => button.addEventListener("click", () => control(`/api/v1/audio/effects/${encodeURIComponent(button.dataset.sfx)}/trigger`)));
$("#master-volume").addEventListener("input", (event) => {
  const volume = Number(event.target.value);
  $("#volume-value").textContent = `${volume}%`;
  if (masterGain && audioContext) masterGain.gain.setTargetAtTime(volume / 100, audioContext.currentTime, 0.025);
  if (fileAudio) fileAudio.volume = volume / 100;
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => control("/api/v1/audio/volume", { volume }), 120);
});

function applyRadioPreset(event) {
  const option = event.target.selectedOptions[0];
  if (!option.value) { $("#radio-name").value = ""; $("#radio-url").value = ""; $("#radio-name").focus(); return; }
  $("#radio-name").value = option.dataset.name || option.textContent;
  $("#radio-url").value = option.value;
}
$("#radio-preset").addEventListener("input", applyRadioPreset);
$("#radio-preset").addEventListener("change", applyRadioPreset);

async function playRadioStation(name, url, target = $("#radio-message")) {
  try {
    await ensureAudio();
    const status = await api("/api/v1/audio/radio/play", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ name, url }) });
    await applyStatus(status, { allowAudio:true });
    target.textContent = `Playing ${name}.`;
    target.className = "library-message success";
  } catch (error) { target.textContent = error.message; target.className = "library-message error"; }
}

$("#radio-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await playRadioStation($("#radio-name").value.trim(), $("#radio-url").value.trim());
});

function searchableText(...values) {
  return values.flat(Infinity).filter(Boolean).join(" ").toLocaleLowerCase();
}

function liveStations() {
  const stations = new Map();
  for (const option of $("#radio-preset").options) {
    if (option.value) stations.set(option.value, { name: option.dataset.name || option.textContent, url: option.value });
  }
  const customName = $("#radio-name").value.trim();
  const customUrl = $("#radio-url").value.trim();
  if (customName && customUrl) stations.set(customUrl, { name: customName, url: customUrl });
  return [...stations.values()];
}

function renderAudioSearchResults(results) {
  if (!results.length) {
    const empty = document.createElement("p");
    empty.className = "library-empty";
    empty.textContent = "No matching audio was found.";
    $("#audio-search-results").replaceChildren(empty);
    return;
  }
  $("#audio-search-results").replaceChildren(...results.map((result) => {
    const row = document.createElement("article");
    row.className = "audio-result";
    const copy = document.createElement("span");
    copy.className = "audio-result-copy";
    const name = document.createElement("strong");
    name.textContent = result.name;
    const detail = document.createElement("small");
    detail.textContent = result.detail;
    copy.append(name, detail);
    const source = document.createElement("span");
    source.className = "audio-result-source";
    source.textContent = result.source;
    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "Play";
    play.addEventListener("click", result.play);
    row.append(copy, source, play);
    return row;
  }));
}

async function searchAudio() {
  const query = $("#audio-search-query").value.trim().toLocaleLowerCase();
  const selectedSource = $("#audio-search-source").value;
  const searchMessage = $("#audio-search-message");
  const includesSource = (source) => selectedSource === "all" || selectedSource === source;
  const matches = (...values) => !query || searchableText(values).includes(query);
  const results = [];
  let usbWarning = "";

  if (includesSource("local")) {
    for (const item of libraryItems) {
      if (!matches(item.name, item.description, item.tags, item.folder_path, item.source?.original_filename)) continue;
      results.push({
        source: "Local",
        name: item.name,
        detail: item.folder_path || item.description || item.tags?.join(" • ") || "Nexus library",
        play: () => item.kind === "effect"
          ? control(`/api/v1/audio/effects/${encodeURIComponent(item.item_id)}/trigger`)
          : playTrack(tracks.findIndex((track) => track.item_id === item.item_id)),
      });
    }
  }

  if (includesSource("usb")) {
    try {
      const usbFiles = await api("/api/v1/audio/usb");
      for (const file of usbFiles) {
        if (!matches(file.name, file.location)) continue;
        results.push({ source:"USB", name:file.name, detail:file.location, play:() => playFromUsb(file.source_path) });
      }
    } catch (error) { usbWarning = error.message; }
  }

  if (includesSource("live")) {
    for (const station of liveStations()) {
      if (!matches(station.name, station.url)) continue;
      results.push({ source:"Live", name:station.name, detail:station.url, play:() => playRadioStation(station.name, station.url, searchMessage) });
    }
  }

  renderAudioSearchResults(results);
  searchMessage.textContent = `${results.length} result${results.length === 1 ? "" : "s"} found.${usbWarning ? ` USB unavailable: ${usbWarning}` : ""}`;
  searchMessage.className = `library-message${usbWarning && selectedSource === "usb" ? " error" : ""}`;
}

$("#audio-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  $("#audio-search-message").textContent = "Searching available audio…";
  try { await searchAudio(); }
  finally { button.disabled = false; }
});

async function reloadLibrary() {
  libraryItems = await api("/api/v1/audio/library");
  tracks.splice(0, tracks.length, ...libraryItems.filter((item) => item.kind === "ambience"));
  renderLibrary();
  renderTrack();
  renderManagedFiles();
  renderRfidAudioOptions();
}

function rfidMessage(text = "", type = "") {
  $("#rfid-message").textContent = text;
  $("#rfid-message").className = `library-message ${type}`.trim();
}

function renderRfidAudioOptions(selected = $("#rfid-audio-item").value) {
  const groups = [
    ["Ambience", libraryItems.filter((item) => item.kind === "ambience")],
    ["Effects", libraryItems.filter((item) => item.kind === "effect")],
  ];
  const nodes = [];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.item_id;
      option.textContent = item.name;
      option.selected = item.item_id === selected;
      group.append(option);
    }
    nodes.push(group);
  }
  $("#rfid-audio-item").replaceChildren(...nodes);
}

function rfidActionLabel(card) {
  if (card.action.type === "audio") {
    const item = libraryItems.find((entry) => entry.item_id === card.action.item_id);
    return item ? `${item.kind === "effect" ? "Effect" : "Play"}: ${item.name}` : `Missing audio: ${card.action.item_id}`;
  }
  return { stop:"Stop playback", pause:"Pause playback", volume_up:"Volume up", volume_down:"Volume down" }[card.action.type] ?? card.action.type;
}

function clearRfidForm() {
  $("#rfid-form").reset();
  $("#rfid-action").value = "audio";
  updateRfidActionField();
  renderRfidAudioOptions();
}

function editRfidCard(card) {
  $("#rfid-uid").value = card.uid;
  $("#rfid-name").value = card.name;
  $("#rfid-action").value = card.action.type;
  updateRfidActionField();
  if (card.action.item_id) renderRfidAudioOptions(card.action.item_id);
  $("#rfid-uid").focus();
  $("#rfid-section")?.scrollIntoView({ behavior:"smooth", block:"start" });
}

function renderRfidCards() {
  $("#rfid-count").textContent = `${rfidCards.length} card${rfidCards.length === 1 ? "" : "s"}`;
  if (!rfidCards.length) {
    const empty = document.createElement("p");
    empty.className = "rfid-empty";
    empty.textContent = "No cards assigned yet. Scan a card and create the first binding.";
    $("#rfid-card-list").replaceChildren(empty);
    return;
  }
  $("#rfid-card-list").replaceChildren(...rfidCards.map((card) => {
    const row = document.createElement("article");
    row.className = "rfid-row";
    const identity = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = card.name;
    const uid = document.createElement("small");
    uid.textContent = card.uid;
    identity.append(name, uid);
    const action = document.createElement("span");
    action.className = "rfid-action-label";
    action.textContent = rfidActionLabel(card);
    const actions = document.createElement("span");
    actions.className = "rfid-row-actions";
    const test = document.createElement("button");
    test.type = "button";
    test.textContent = "Test";
    test.addEventListener("click", () => testRfidUid(card.uid));
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => editRfidCard(card));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteRfidCard(card));
    actions.append(test, edit, remove);
    row.append(identity, action, actions);
    return row;
  }));
}

async function reloadRfidCards() {
  rfidCards = await api("/api/v1/rfid/cards");
  renderRfidCards();
}

function renderLastRfidScan(scan) {
  if (!scan) return;
  latestRfidScan = scan;
  $("#rfid-last-scan").textContent = scan.uid;
  const cardName = scan.card?.name ? ` · ${scan.card.name}` : " · Unassigned card";
  const outcomes = { executed:"Action executed", ignored_delay:"Repeat scan ignored", released:"Card removed", unassigned:"No binding assigned" };
  $("#rfid-last-outcome").textContent = `${outcomes[scan.outcome] ?? scan.outcome}${cardName}`;
}

async function refreshRfidScan() {
  try {
    const scan = await api("/api/v1/rfid/last-scan");
    if (scan?.scanned_at !== latestRfidScan?.scanned_at) renderLastRfidScan(scan);
  } catch { /* Reader status should not interrupt audio playback. */ }
}

async function testRfidUid(uid) {
  if (!uid.trim()) return rfidMessage("Enter or scan a card UID first.", "error");
  try {
    await ensureAudio();
    const result = await api("/api/v1/rfid/scan", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ uid }) });
    renderLastRfidScan(result);
    await applyStatus(result.audio, { allowAudio:true });
    rfidMessage(result.outcome === "unassigned" ? "That card is not assigned yet." : `Scan result: ${result.outcome.replaceAll("_", " ")}.`, result.outcome === "executed" ? "success" : "");
  } catch (error) { rfidMessage(error.message, "error"); }
}

async function deleteRfidCard(card) {
  if (!window.confirm(`Delete the binding for ${card.name}?`)) return;
  try {
    await api(`/api/v1/rfid/cards/${encodeURIComponent(card.uid)}`, { method:"DELETE" });
    await reloadRfidCards();
    rfidMessage(`${card.name} deleted.`, "success");
  } catch (error) { rfidMessage(error.message, "error"); }
}

function updateRfidActionField() {
  const audioAction = $("#rfid-action").value === "audio";
  $("#rfid-audio-field").hidden = !audioAction;
  $("#rfid-audio-item").disabled = !audioAction;
  $("#rfid-audio-item").required = audioAction;
}

$("#rfid-action").addEventListener("change", updateRfidActionField);
$("#rfid-clear").addEventListener("click", clearRfidForm);
$("#rfid-use-scan").addEventListener("click", () => {
  if (!latestRfidScan) return rfidMessage("No card has been scanned yet.", "error");
  $("#rfid-uid").value = latestRfidScan.uid;
  if (latestRfidScan.card) editRfidCard(latestRfidScan.card);
  else $("#rfid-name").focus();
});
$("#rfid-simulate").addEventListener("click", () => testRfidUid($("#rfid-uid").value));
$("#rfid-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const actionType = $("#rfid-action").value;
  const action = actionType === "audio" ? { type:actionType, item_id:$("#rfid-audio-item").value } : { type:actionType };
  try {
    const saved = await api("/api/v1/rfid/cards", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ uid:$("#rfid-uid").value, name:$("#rfid-name").value, action }) });
    await reloadRfidCards();
    clearRfidForm();
    rfidMessage(`${saved.name} is ready to scan.`, "success");
  } catch (error) { rfidMessage(error.message, "error"); }
});

async function reloadFolders() {
  folders = await api("/api/v1/audio/folders");
  renderFolders();
}

async function moveFile(itemId, folderPath) {
  try {
    await api(`/api/v1/audio/files/${encodeURIComponent(itemId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder_path: folderPath }) });
    await reloadLibrary();
    libraryMessage("Audio file moved.", "success");
  } catch (error) { libraryMessage(error.message, "error"); }
}

async function importUsb(sourcePath) {
  try {
    await api("/api/v1/audio/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source_path: sourcePath, folder_path: $("#library-folder").value, kind: "ambience" }) });
    await reloadLibrary();
    libraryMessage("USB audio imported.", "success");
  } catch (error) { libraryMessage(error.message, "error"); }
}

async function playFromUsb(sourcePath) {
  try {
    await ensureAudio();
    const status = await api("/api/v1/audio/usb/play", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source_path: sourcePath }) });
    await applyStatus(status, { allowAudio: true });
    libraryMessage(`Playing ${status.item.name} directly from USB.`, "success");
  } catch (error) { libraryMessage(error.message, "error"); }
}

$("#library-folder").addEventListener("change", renderManagedFiles);
$("#folder-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#folder-name").value.trim();
  if (!name) return libraryMessage("Enter a folder name.", "error");
  try {
    const created = await api("/api/v1/audio/folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parent_path: $("#library-folder").value, name }) });
    await reloadFolders();
    $("#library-folder").value = created.folder_path;
    $("#folder-name").value = "";
    renderManagedFiles();
    libraryMessage(`Created ${created.folder_path}.`, "success");
  } catch (error) { libraryMessage(error.message, "error"); }
});
$("#upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const files = [...$("#audio-upload").files];
  if (!files.length) return libraryMessage("Choose one or more audio files.", "error");
  try {
    for (const file of files) {
      libraryMessage(`Uploading ${file.name}…`);
      const query = new URLSearchParams({ filename: file.name, folder: $("#library-folder").value, kind: "ambience" });
      await api(`/api/v1/audio/files/upload?${query}`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
    }
    $("#audio-upload").value = "";
    await reloadLibrary();
    libraryMessage(`${files.length} audio file${files.length === 1 ? "" : "s"} uploaded.`, "success");
  } catch (error) { libraryMessage(error.message, "error"); }
});
$("#scan-usb").addEventListener("click", async () => {
  try {
    libraryMessage("Scanning configured USB mounts…");
    const files = await api("/api/v1/audio/usb");
    renderUsbFiles(files);
    libraryMessage(files.length ? "USB scan complete." : "No USB audio found.");
  } catch (error) { libraryMessage(error.message, "error"); }
});

async function refresh() {
  try { await applyStatus(await api("/api/v1/audio/status")); }
  catch (error) { message(error.message, "error"); }
}

async function initialize() {
  try {
    await reloadLibrary();
    try { await reloadFolders(); }
    catch (error) { libraryMessage(error.message, "error"); }
    try { await reloadRfidCards(); }
    catch (error) { rfidMessage(error.message, "error"); }
    await refreshRfidScan();
    await refresh();
    setInterval(refresh, 1000);
    setInterval(refreshRfidScan, 1000);
  } catch (error) {
    message(error.message, "error");
  }
}

renderPlayback();
updateRfidActionField();
requestAnimationFrame(updateProgress);
initialize();
