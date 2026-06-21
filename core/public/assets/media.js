const $ = (selector) => document.querySelector(selector);
const tracks = [
  { title: "Lantern & Oak", subtitle: "Warm tavern drone • Seamless ambience", duration: 240, frequencies: [110, 164.81, 220], wave: "sine", cutoff: 720, noise: 0.018, pulse: 0 },
  { title: "Understone Hollow", subtitle: "Deep cavern resonance • Seamless ambience", duration: 320, frequencies: [55, 82.41, 123.47], wave: "sine", cutoff: 260, noise: 0.032, pulse: 0 },
  { title: "Initiative Rising", subtitle: "Rhythmic battle tension • Seamless ambience", duration: 210, frequencies: [65.41, 98, 130.81], wave: "sawtooth", cutoff: 520, noise: 0.012, pulse: 0.68 },
];

let audioContext;
let masterGain;
let trackBus;
let activeNodes = [];
let pulseTimer;
let currentTrack = 0;
let isPlaying = false;
let elapsedBeforePlay = 0;
let startedAt = 0;

function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
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
  for (const node of activeNodes) { try { node.stop(); } catch { /* Node may already be stopped. */ } try { node.disconnect(); } catch { /* Ignore disconnected nodes. */ } }
  activeNodes = [];
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
  for (let index = 0; index < channel.length; index += 1) { const white = Math.random() * 2 - 1; last = last * 0.985 + white * 0.015; channel[index] = last; }
  const source = audioContext.createBufferSource();
  const filter = audioContext.createBiquadFilter();
  const gain = audioContext.createGain();
  source.buffer = buffer;
  source.loop = true;
  filter.type = "lowpass";
  filter.frequency.value = track.cutoff;
  gain.gain.value = track.noise;
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
  track.frequencies.forEach((frequency, index) => {
    const gain = addOscillator(frequency, track.wave, track.wave === "sawtooth" ? 0.012 : 0.032 / (index + 1));
    const lfo = audioContext.createOscillator();
    const lfoGain = audioContext.createGain();
    lfo.frequency.value = 0.035 + index * 0.017;
    lfoGain.gain.value = 0.006;
    lfo.connect(lfoGain).connect(gain.gain);
    lfo.start();
    activeNodes.push(lfo, lfoGain);
  });
  addNoise(track);
  if (track.pulse) { playBattlePulse(); pulseTimer = setInterval(playBattlePulse, track.pulse * 1000); }
}

function renderTrack() {
  const track = tracks[currentTrack];
  $("#track-title").textContent = track.title;
  $("#track-subtitle").textContent = track.subtitle;
  $("#duration").textContent = formatTime(track.duration);
  document.querySelectorAll(".queue-track").forEach((button) => button.classList.toggle("active", Number(button.dataset.track) === currentTrack));
}

function renderPlayback() {
  $("#now-playing").classList.toggle("is-playing", isPlaying);
  $("#play-track").textContent = isPlaying ? "Ⅱ" : "▶";
  $("#play-track").setAttribute("aria-label", isPlaying ? "Pause" : "Play");
}

async function startTrack(index = currentTrack) {
  await ensureAudio();
  currentTrack = (index + tracks.length) % tracks.length;
  buildTrack(tracks[currentTrack]);
  elapsedBeforePlay = 0;
  startedAt = audioContext.currentTime;
  isPlaying = true;
  trackBus.gain.setTargetAtTime(1, audioContext.currentTime, 0.04);
  renderTrack();
  renderPlayback();
}

async function togglePlayback() {
  try {
    await ensureAudio();
    if (activeNodes.length === 0) return startTrack();
    if (isPlaying) {
      elapsedBeforePlay += audioContext.currentTime - startedAt;
      trackBus.gain.setTargetAtTime(0.0001, audioContext.currentTime, 0.035);
      isPlaying = false;
    } else {
      startedAt = audioContext.currentTime;
      trackBus.gain.setTargetAtTime(1, audioContext.currentTime, 0.04);
      isPlaying = true;
    }
    renderPlayback();
  } catch (error) { $("#track-subtitle").textContent = error.message; }
}

function stopPlayback() {
  stopNodes();
  if (trackBus && audioContext) trackBus.gain.setValueAtTime(0, audioContext.currentTime);
  isPlaying = false;
  elapsedBeforePlay = 0;
  $("#progress-bar").style.width = "0%";
  $("#elapsed").textContent = "0:00";
  renderPlayback();
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
    const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain();
    oscillator.type = type; oscillator.frequency.setValueAtTime(from, now); oscillator.frequency.exponentialRampToValueAtTime(to, now + duration);
    gain.gain.setValueAtTime(volume, now); gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(masterGain); oscillator.start(now); oscillator.stop(now + duration);
  };
  if (name === "thunder") { tone("sine", 78, 28, 1.8, 0.38); playNoiseBurst({ duration: 2, cutoff: 180, gainValue: 0.32 }); }
  if (name === "door") { tone("sawtooth", 105, 42, 0.9, 0.16); playNoiseBurst({ duration: 0.7, cutoff: 420, gainValue: 0.12 }); }
  if (name === "blade") { tone("square", 1200, 340, 0.28, 0.12); playNoiseBurst({ duration: 0.18, cutoff: 4200, gainValue: 0.09 }); }
  if (name === "magic") { tone("sine", 330, 990, 1.15, 0.16); tone("triangle", 495, 1480, 0.95, 0.07); }
}

function updateProgress() {
  const track = tracks[currentTrack];
  let elapsed = elapsedBeforePlay;
  if (isPlaying && audioContext) elapsed += audioContext.currentTime - startedAt;
  if (elapsed >= track.duration) { elapsed %= track.duration; elapsedBeforePlay = elapsed; startedAt = audioContext?.currentTime ?? 0; }
  $("#elapsed").textContent = formatTime(elapsed);
  $("#progress-bar").style.width = `${(elapsed / track.duration) * 100}%`;
  requestAnimationFrame(updateProgress);
}

$("#play-track").addEventListener("click", togglePlayback);
$("#stop-track").addEventListener("click", stopPlayback);
$("#previous-track").addEventListener("click", () => isPlaying ? startTrack(currentTrack - 1) : (currentTrack = (currentTrack - 1 + tracks.length) % tracks.length, renderTrack()));
$("#next-track").addEventListener("click", () => isPlaying ? startTrack(currentTrack + 1) : (currentTrack = (currentTrack + 1) % tracks.length, renderTrack()));
document.querySelectorAll(".queue-track").forEach((button) => button.addEventListener("click", () => startTrack(Number(button.dataset.track))));
document.querySelectorAll("[data-sfx]").forEach((button) => button.addEventListener("click", () => playEffect(button.dataset.sfx)));
$("#master-volume").addEventListener("input", (event) => { const volume = Number(event.target.value); $("#volume-value").textContent = `${volume}%`; if (masterGain && audioContext) masterGain.gain.setTargetAtTime(volume / 100, audioContext.currentTime, 0.025); });

renderTrack();
renderPlayback();
requestAnimationFrame(updateProgress);
