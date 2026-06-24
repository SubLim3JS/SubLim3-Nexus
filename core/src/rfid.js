import { DEFAULT_PLAYER_SETTINGS } from "./player-settings.js";

const LAST_SCAN_ID = "last-scan";
const ACTION_TYPES = new Set(["audio", "stop", "pause", "volume_up", "volume_down"]);

function rfidError(message, statusCode = 422) {
  return Object.assign(new Error(message), { statusCode });
}

export function normalizeRfidUid(value) {
  if (typeof value !== "string") throw rfidError("RFID uid is required");
  const uid = value.trim().replaceAll(/[:\s-]/g, "").toLowerCase();
  if (!/^[a-f0-9]{4,64}$/.test(uid)) throw rfidError("RFID uid must contain 4-64 hexadecimal characters");
  return uid;
}

function normalizeCard(input, existing, now) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw rfidError("RFID card must be an object");
  const uid = normalizeRfidUid(input.uid ?? input.card_id);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100) throw rfidError("RFID card name must be 1-100 characters");
  const action = input.action;
  if (!action || typeof action !== "object" || Array.isArray(action) || !ACTION_TYPES.has(action.type)) {
    throw rfidError(`RFID action type must be one of: ${[...ACTION_TYPES].join(", ")}`);
  }
  const itemId = action.type === "audio" && typeof action.item_id === "string" ? action.item_id.trim() : null;
  if (action.type === "audio" && !itemId) throw rfidError("Audio cards require an item_id");
  const timestamp = now.toISOString();
  return {
    card_id: uid,
    uid,
    name,
    action: itemId ? { type: action.type, item_id: itemId } : { type: action.type },
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp,
  };
}

export class RfidService {
  constructor({ cardStore, stateStore, audio, settings = async () => DEFAULT_PLAYER_SETTINGS, now = () => new Date() }) {
    this.cardStore = cardStore;
    this.stateStore = stateStore;
    this.audio = audio;
    this.settings = settings;
    this.now = now;
    this.mutation = Promise.resolve();
  }

  async initialize() {
    await Promise.all([this.cardStore.initialize(), this.stateStore.initialize()]);
  }

  async cards() {
    return (await this.cardStore.list()).sort((left, right) => left.name.localeCompare(right.name));
  }

  async saveCard(input) {
    const uid = normalizeRfidUid(input?.uid ?? input?.card_id);
    const existing = await this.cardStore.get(uid);
    const card = normalizeCard(input, existing, this.now());
    if (card.action.type === "audio") await this.audio.item(card.action.item_id);
    return this.cardStore.put(uid, card);
  }

  async deleteCard(uid) {
    return this.cardStore.delete(normalizeRfidUid(uid));
  }

  async lastScan() {
    return this.stateStore.get(LAST_SCAN_ID);
  }

  async execute(card, settings, previous) {
    const status = await this.audio.status();
    if (card.action.type === "audio") {
      const item = await this.audio.item(card.action.item_id);
      if (item.kind === "effect") return this.audio.triggerEffect(item.item_id);
      const isSecondScan = previous?.uid === card.uid && status.item_id === item.item_id;
      if (!isSecondScan) return this.audio.play(item.item_id);
      if (settings.rfid_second_scan === "ignore") return status;
      if (settings.rfid_second_scan === "restart") {
        await this.audio.stop();
        return this.audio.play(item.item_id);
      }
      return status.state === "playing" ? this.audio.pause() : this.audio.play(item.item_id);
    }
    if (card.action.type === "stop") return this.audio.stop();
    if (card.action.type === "pause") return this.audio.pause();
    const direction = card.action.type === "volume_up" ? 1 : -1;
    const volume = Math.max(0, Math.min(settings.maximum_volume, status.volume + direction * settings.volume_step));
    return this.audio.setVolume(volume);
  }

  async scan(input) {
    const operation = this.mutation.then(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw rfidError("RFID scan must be an object");
      const uid = normalizeRfidUid(input.uid);
      const present = input.present !== false;
      const now = this.now();
      const previous = await this.lastScan();
      const settings = { ...DEFAULT_PLAYER_SETTINGS, ...await this.settings() };
      const card = await this.cardStore.get(uid);
      let outcome = "unassigned";
      let audioStatus = await this.audio.status();

      if (!present) {
        outcome = "released";
        if (settings.rfid_scan_mode === "place" && previous?.uid === uid && previous?.present !== false) audioStatus = await this.audio.stop();
      } else if (card) {
        const elapsed = previous?.uid === uid ? now.getTime() - Date.parse(previous.scanned_at) : Infinity;
        const isFunctionCard = card.action.type !== "audio";
        if (elapsed < settings.rfid_rescan_delay_seconds * 1000 && !(isFunctionCard && settings.function_cards_bypass_delay)) {
          outcome = "ignored_delay";
        } else {
          audioStatus = await this.execute(card, settings, previous);
          outcome = "executed";
        }
      }

      const result = {
        uid,
        present,
        scanned_at: now.toISOString(),
        outcome,
        card,
        audio: audioStatus,
      };
      await this.stateStore.put(LAST_SCAN_ID, result);
      return result;
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }
}
