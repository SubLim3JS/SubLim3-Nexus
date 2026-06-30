const SETTINGS_ID = "player";

export const DEFAULT_PLAYER_SETTINGS = Object.freeze({
  maximum_volume: 100,
  startup_volume: 55,
  volume_step: 5,
  stop_playout_minutes: 0,
  rfid_scan_mode: "swipe",
  rfid_second_scan: "toggle",
  rfid_rescan_delay_seconds: 2,
  function_cards_bypass_delay: true,
  audio_output_device: "pi",
});

function settingsError(message) {
  return Object.assign(new Error(message), { statusCode: 422 });
}

function choice(value, allowed, label) {
  if (!allowed.includes(value)) throw settingsError(`${label} is invalid`);
  return value;
}

function integer(value, minimum, maximum, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw settingsError(`${label} must be between ${minimum} and ${maximum}`);
  return number;
}

export class PlayerSettingsService {
  constructor({ store, now = () => new Date() }) {
    this.store = store;
    this.now = now;
  }

  async initialize() {
    await this.store.initialize();
    if (!await this.store.get(SETTINGS_ID)) await this.store.put(SETTINGS_ID, { ...DEFAULT_PLAYER_SETTINGS, updated_at: this.now().toISOString() });
  }

  async get() {
    return { ...DEFAULT_PLAYER_SETTINGS, ...(await this.store.get(SETTINGS_ID) ?? {}) };
  }

  async update(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw settingsError("Player settings must be an object");
    const current = await this.get();
    const next = {
      ...current,
      maximum_volume: input.maximum_volume === undefined ? current.maximum_volume : integer(input.maximum_volume, 10, 100, "Maximum volume"),
      startup_volume: input.startup_volume === undefined ? current.startup_volume : integer(input.startup_volume, 0, 100, "Startup volume"),
      volume_step: input.volume_step === undefined ? current.volume_step : choice(Number(input.volume_step), [1, 2, 5, 10], "Volume step"),
      stop_playout_minutes: input.stop_playout_minutes === undefined ? current.stop_playout_minutes : choice(Number(input.stop_playout_minutes), [0, 15, 30, 60, 120], "Stop playout timer"),
      rfid_scan_mode: input.rfid_scan_mode === undefined ? current.rfid_scan_mode : choice(input.rfid_scan_mode, ["swipe", "place"], "RFID scan mode"),
      rfid_second_scan: input.rfid_second_scan === undefined ? current.rfid_second_scan : choice(input.rfid_second_scan, ["toggle", "restart", "ignore"], "Second scan action"),
      rfid_rescan_delay_seconds: input.rfid_rescan_delay_seconds === undefined ? current.rfid_rescan_delay_seconds : choice(Number(input.rfid_rescan_delay_seconds), [0, 1, 2, 3, 5, 10], "RFID rescan delay"),
      function_cards_bypass_delay: input.function_cards_bypass_delay === undefined ? current.function_cards_bypass_delay : input.function_cards_bypass_delay,
      audio_output_device: input.audio_output_device === undefined ? current.audio_output_device : choice(input.audio_output_device, ["pi", "bluetooth"], "Audio output device"),
      updated_at: this.now().toISOString(),
    };
    if (typeof next.function_cards_bypass_delay !== "boolean") throw settingsError("Function-card delay bypass must be true or false");
    if (next.startup_volume > next.maximum_volume) throw settingsError("Startup volume cannot exceed maximum volume");
    await this.store.put(SETTINGS_ID, next);
    return next;
  }
}
