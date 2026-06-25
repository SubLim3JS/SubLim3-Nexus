import { randomUUID } from "node:crypto";
import { DEFAULT_PLAYER_SETTINGS } from "./player-settings.js";
import { BrowserAudioOutput } from "./platform/audio-output.js";

export const BUILT_IN_AUDIO_ITEMS = [
  {
    item_id: "lantern-and-oak",
    name: "Lantern & Oak",
    kind: "ambience",
    description: "Warm tavern drone",
    sort_order: 10,
    tags: ["Tavern", "Warm", "Social"],
    duration_seconds: 240,
    loop: true,
    synthesis: { frequencies: [110, 164.81, 220], wave: "sine", cutoff: 720, noise: 0.018, pulse: 0 },
  },
  {
    item_id: "understone-hollow",
    name: "Understone Hollow",
    kind: "ambience",
    description: "Deep cavern resonance",
    sort_order: 20,
    tags: ["Cavern", "Distant", "Uneasy"],
    duration_seconds: 320,
    loop: true,
    synthesis: { frequencies: [55, 82.41, 123.47], wave: "sine", cutoff: 260, noise: 0.032, pulse: 0 },
  },
  {
    item_id: "initiative-rising",
    name: "Initiative Rising",
    kind: "ambience",
    description: "Rhythmic battle tension",
    sort_order: 30,
    tags: ["Battle", "Pulse", "Urgent"],
    duration_seconds: 210,
    loop: true,
    synthesis: { frequencies: [65.41, 98, 130.81], wave: "sawtooth", cutoff: 520, noise: 0.012, pulse: 0.68 },
  },
  { item_id: "thunder", name: "Thunder", kind: "effect", description: "Low rolling impact", tags: ["Weather"], sort_order: 10, synthesis: { frequencies: [38, 55], wave: "sine", noise: 0.14, duration_seconds: 2.4 } },
  { item_id: "ancient-door", name: "Ancient Door", kind: "effect", description: "Stone and timber", tags: ["Dungeon"], sort_order: 20, synthesis: { frequencies: [72, 108], wave: "sawtooth", noise: 0.08, duration_seconds: 1.2 } },
  { item_id: "blade-clash", name: "Blade Clash", kind: "effect", description: "Metallic strike", tags: ["Combat"], sort_order: 30, synthesis: { frequencies: [740, 1110, 1480], wave: "sine", noise: 0.04, duration_seconds: 0.55 } },
  { item_id: "arcane-pulse", name: "Arcane Pulse", kind: "effect", description: "Resonant energy", tags: ["Magic"], sort_order: 40, synthesis: { frequencies: [220, 329.63, 493.88], wave: "sine", noise: 0.015, duration_seconds: 1.1 } },
  { item_id: "system-update-success", name: "Update Success", kind: "effect", description: "Bright confirmation tone", tags: ["System"], sort_order: 900, synthesis: { frequencies: [660, 880], wave: "sine", noise: 0, duration_seconds: 0.45 } },
  { item_id: "system-update-failure", name: "Update Failure", kind: "effect", description: "Low warning tone", tags: ["System"], sort_order: 910, synthesis: { frequencies: [220, 185], wave: "sawtooth", noise: 0.01, duration_seconds: 0.65 } },
];

const STATE_ID = "global";

function audioError(message, statusCode = 422) {
  return Object.assign(new Error(message), { statusCode });
}

function initialState(now, preferences = DEFAULT_PLAYER_SETTINGS, output = { driver: "browser_preview", name: "Browser renderer", available: true, server_playback: false }) {
  return {
    state: "stopped",
    item_id: null,
    external_item: null,
    position_seconds: 0,
    started_at: null,
    volume: preferences.startup_volume,
    revision: 0,
    last_effect: null,
    output,
    updated_at: now.toISOString(),
  };
}

export class AudioService {
  constructor({ libraryStore, stateStore, files = null, output = new BrowserAudioOutput(), preferences = DEFAULT_PLAYER_SETTINGS, now = () => new Date() }) {
    this.libraryStore = libraryStore;
    this.stateStore = stateStore;
    this.files = files;
    this.output = output;
    this.now = now;
    this.preferences = { ...DEFAULT_PLAYER_SETTINGS, ...preferences };
    this.mutation = Promise.resolve();
    this.stopTimer = null;
  }

  async initialize() {
    await Promise.all([this.libraryStore.initialize(), this.stateStore.initialize(), this.files?.initialize(), this.output.initialize()]);
    await Promise.all(BUILT_IN_AUDIO_ITEMS.map(async (item) => {
      const existing = await this.libraryStore.get(item.item_id);
      if (!existing || existing.built_in) {
        await this.libraryStore.put(item.item_id, { ...item, built_in: true });
      }
    }));
    const existingState = await this.stateStore.get(STATE_ID);
    const output = this.output.info();
    if (!existingState) await this.stateStore.put(STATE_ID, initialState(this.now(), this.preferences, output));
    else await this.stateStore.put(STATE_ID, {
      ...existingState,
      ...(existingState.external_item ? { state: "stopped", item_id: null, external_item: null, position_seconds: 0, started_at: null } : {}),
      volume: this.preferences.startup_volume,
      output,
      updated_at: this.now().toISOString(),
    });
  }

  async outputCall(method, ...args) {
    try { return await this.output[method]?.(...args); }
    catch { return false; }
  }

  async library(kind = null) {
    const items = await this.libraryStore.list();
    return (kind ? items.filter((item) => item.kind === kind) : items)
      .sort((left, right) => (Number(left.sort_order) || 999) - (Number(right.sort_order) || 999) || left.name.localeCompare(right.name));
  }

  async item(itemId, kind = null) {
    const item = typeof itemId === "string" ? await this.libraryStore.get(itemId) : null;
    if (!item || (kind && item.kind !== kind)) throw audioError(`${kind === "effect" ? "Effect" : "Audio item"} not found`, 404);
    return item;
  }

  position(state, at = this.now()) {
    if (state.state !== "playing" || !state.started_at) return Number(state.position_seconds) || 0;
    return Math.max(0, (Number(state.position_seconds) || 0) + (at.getTime() - Date.parse(state.started_at)) / 1000);
  }

  async status() {
    const state = await this.stateStore.get(STATE_ID) ?? initialState(this.now(), this.preferences);
    const item = state.external_item?.item_id === state.item_id ? state.external_item : state.item_id ? await this.libraryStore.get(state.item_id) : null;
    let position = this.position(state);
    if (item?.duration_seconds && item.loop) position %= item.duration_seconds;
    else if (item?.duration_seconds) position = Math.min(position, item.duration_seconds);
    return { ...state, position_seconds: position, item };
  }

  async change(mutator) {
    const operation = this.mutation.then(async () => {
      const now = this.now();
      const current = await this.stateStore.get(STATE_ID) ?? initialState(now, this.preferences);
      const next = await mutator(current, now);
      const saved = { ...next, revision: (Number(current.revision) || 0) + 1, updated_at: now.toISOString() };
      await this.stateStore.put(STATE_ID, saved);
      return this.status();
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }

  scheduleStop(status) {
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const minutes = Number(this.preferences.stop_playout_minutes) || 0;
    if (status?.state !== "playing" || minutes <= 0) return;
    this.stopTimer = setTimeout(() => this.stop().catch(() => {}), minutes * 60_000);
    this.stopTimer.unref?.();
  }

  async applyPreferences(preferences) {
    this.preferences = { ...DEFAULT_PLAYER_SETTINGS, ...preferences };
    const status = await this.status();
    if (status.volume > this.preferences.maximum_volume) return this.setVolume(this.preferences.maximum_volume);
    this.scheduleStop(status);
    return status;
  }

  async play(itemId) {
    const item = await this.item(itemId, "ambience");
    const status = await this.change((current, now) => ({
      ...current,
      state: "playing",
      item_id: item.item_id,
      external_item: null,
      position_seconds: current.item_id === item.item_id ? this.position(current, now) : 0,
      started_at: now.toISOString(),
    }));
    await this.outputCall("play", item, { files: this.files, position: status.position_seconds, volume: status.volume });
    this.scheduleStop(status);
    return status;
  }

  async playUsb(sourcePath) {
    if (!this.files) throw audioError("USB playback is unavailable", 503);
    const item = await this.files.describeUsb(sourcePath);
    const status = await this.change((current, now) => ({
      ...current,
      state: "playing",
      item_id: item.item_id,
      external_item: item,
      position_seconds: 0,
      started_at: now.toISOString(),
    }));
    await this.outputCall("play", item, { files: this.files, position: 0, volume: status.volume });
    this.scheduleStop(status);
    return status;
  }

  async playRadio({ name, url }) {
    const stationName = typeof name === "string" ? name.trim() : "";
    if (!stationName || stationName.length > 100) throw audioError("Radio station name must be 1-100 characters");
    let streamUrl;
    try { streamUrl = new URL(url); }
    catch { throw audioError("Radio stream must be a valid HTTP or HTTPS URL"); }
    if (!["http:", "https:"].includes(streamUrl.protocol) || streamUrl.username || streamUrl.password) {
      throw audioError("Radio stream must be a valid HTTP or HTTPS URL without embedded credentials");
    }
    if (streamUrl.href.length > 2_000) throw audioError("Radio stream URL is too long");
    const item = {
      item_id: `radio-${randomUUID()}`,
      name: stationName,
      kind: "ambience",
      description: "Live online radio",
      tags: ["Radio", "Live"],
      duration_seconds: null,
      loop: false,
      source: { type: "radio", stream_url: streamUrl.href },
    };
    const status = await this.change((current, now) => ({
      ...current,
      state: "playing",
      item_id: item.item_id,
      external_item: item,
      position_seconds: 0,
      started_at: now.toISOString(),
    }));
    await this.outputCall("play", item, { files: this.files, position: 0, volume: status.volume });
    this.scheduleStop(status);
    return status;
  }

  async pause() {
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const status = await this.change((current, now) => ({
      ...current,
      state: current.item_id ? "paused" : "stopped",
      position_seconds: this.position(current, now),
      started_at: null,
    }));
    await this.outputCall("pause");
    return status;
  }

  async stop() {
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const status = await this.change((current) => ({
      ...current,
      state: "stopped",
      item_id: current.external_item ? null : current.item_id,
      external_item: null,
      position_seconds: 0,
      started_at: null,
    }));
    await this.outputCall("stop");
    return status;
  }

  async setVolume(value) {
    const volume = Number(value);
    if (!Number.isFinite(volume) || volume < 0 || volume > this.preferences.maximum_volume) throw audioError(`volume must be between 0 and ${this.preferences.maximum_volume}`);
    const status = await this.change((current) => ({ ...current, volume: Math.round(volume) }));
    await this.outputCall("setVolume", status.volume);
    return status;
  }

  async triggerEffect(itemId) {
    const item = await this.item(itemId, "effect");
    const status = await this.change((current, now) => ({
      ...current,
      last_effect: { event_id: randomUUID(), item_id: item.item_id, triggered_at: now.toISOString() },
    }));
    await this.outputCall("triggerEffect", item, { files: this.files, volume: status.volume });
    return status;
  }
}
