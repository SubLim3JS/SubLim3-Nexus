import { randomUUID } from "node:crypto";

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
  { item_id: "thunder", name: "Thunder", kind: "effect", description: "Low rolling impact", tags: ["Weather"], sort_order: 10 },
  { item_id: "ancient-door", name: "Ancient Door", kind: "effect", description: "Stone and timber", tags: ["Dungeon"], sort_order: 20 },
  { item_id: "blade-clash", name: "Blade Clash", kind: "effect", description: "Metallic strike", tags: ["Combat"], sort_order: 30 },
  { item_id: "arcane-pulse", name: "Arcane Pulse", kind: "effect", description: "Resonant energy", tags: ["Magic"], sort_order: 40 },
];

const STATE_ID = "global";

function audioError(message, statusCode = 422) {
  return Object.assign(new Error(message), { statusCode });
}

function initialState(now) {
  return {
    state: "stopped",
    item_id: null,
    external_item: null,
    position_seconds: 0,
    started_at: null,
    volume: 55,
    revision: 0,
    last_effect: null,
    output: { driver: "browser_preview", name: "Browser renderer" },
    updated_at: now.toISOString(),
  };
}

export class AudioService {
  constructor({ libraryStore, stateStore, files = null, now = () => new Date() }) {
    this.libraryStore = libraryStore;
    this.stateStore = stateStore;
    this.files = files;
    this.now = now;
    this.mutation = Promise.resolve();
  }

  async initialize() {
    await Promise.all([this.libraryStore.initialize(), this.stateStore.initialize(), this.files?.initialize()]);
    await Promise.all(BUILT_IN_AUDIO_ITEMS.map(async (item) => {
      const existing = await this.libraryStore.get(item.item_id);
      if (!existing || existing.built_in) {
        await this.libraryStore.put(item.item_id, { ...item, built_in: true });
      }
    }));
    const existingState = await this.stateStore.get(STATE_ID);
    if (!existingState) await this.stateStore.put(STATE_ID, initialState(this.now()));
    else if (existingState.external_item) await this.stateStore.put(STATE_ID, { ...existingState, state: "stopped", item_id: null, external_item: null, position_seconds: 0, started_at: null, updated_at: this.now().toISOString() });
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
    const state = await this.stateStore.get(STATE_ID) ?? initialState(this.now());
    const item = state.external_item?.item_id === state.item_id ? state.external_item : state.item_id ? await this.libraryStore.get(state.item_id) : null;
    let position = this.position(state);
    if (item?.duration_seconds && item.loop) position %= item.duration_seconds;
    else if (item?.duration_seconds) position = Math.min(position, item.duration_seconds);
    return { ...state, position_seconds: position, item };
  }

  async change(mutator) {
    const operation = this.mutation.then(async () => {
      const now = this.now();
      const current = await this.stateStore.get(STATE_ID) ?? initialState(now);
      const next = await mutator(current, now);
      const saved = { ...next, revision: (Number(current.revision) || 0) + 1, updated_at: now.toISOString() };
      await this.stateStore.put(STATE_ID, saved);
      return this.status();
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }

  async play(itemId) {
    const item = await this.item(itemId, "ambience");
    return this.change((current, now) => ({
      ...current,
      state: "playing",
      item_id: item.item_id,
      external_item: null,
      position_seconds: current.item_id === item.item_id ? this.position(current, now) : 0,
      started_at: now.toISOString(),
    }));
  }

  async playUsb(sourcePath) {
    if (!this.files) throw audioError("USB playback is unavailable", 503);
    const item = await this.files.describeUsb(sourcePath);
    return this.change((current, now) => ({
      ...current,
      state: "playing",
      item_id: item.item_id,
      external_item: item,
      position_seconds: 0,
      started_at: now.toISOString(),
    }));
  }

  async pause() {
    return this.change((current, now) => ({
      ...current,
      state: current.item_id ? "paused" : "stopped",
      position_seconds: this.position(current, now),
      started_at: null,
    }));
  }

  async stop() {
    return this.change((current) => ({
      ...current,
      state: "stopped",
      item_id: current.external_item ? null : current.item_id,
      external_item: null,
      position_seconds: 0,
      started_at: null,
    }));
  }

  async setVolume(value) {
    const volume = Number(value);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw audioError("volume must be between 0 and 100");
    return this.change((current) => ({ ...current, volume: Math.round(volume) }));
  }

  async triggerEffect(itemId) {
    const item = await this.item(itemId, "effect");
    return this.change((current, now) => ({
      ...current,
      last_effect: { event_id: randomUUID(), item_id: item.item_id, triggered_at: now.toISOString() },
    }));
  }
}
