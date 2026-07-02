import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { JsonStore } from "./storage/json-store.js";
import { collectSystemInfo } from "./system-info.js";
import { CommandRunner } from "./platform/command-runner.js";
import { ConnectivityService } from "./platform/connectivity.js";
import { SystemControlService } from "./platform/system-control.js";
import { AccessService } from "./access.js";
import { LiveEvents } from "./live-events.js";
import { applyGameSystemDefaults } from "./game-system.js";
import { loadBundledExpansionPacks } from "./expansion-packs.js";
import { normalizeCharacter } from "./character.js";
import { AudioService } from "./audio.js";
import { AudioFileService } from "./audio-files.js";
import { BrowserAudioOutput, MpvAudioOutput } from "./platform/audio-output.js";
import { PlayerSettingsService } from "./player-settings.js";
import { RfidService } from "./rfid.js";
import { HardwareInputService, shouldStartHardware } from "./platform/hardware-input.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.NEXUS_DATA_DIR ?? path.resolve(directory, "../data");
const expansionSourceDirectory = process.env.NEXUS_EXPANSIONS_DIR ?? path.join(dataDirectory, "expansions", "repo-cache");
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const commandRunner = new CommandRunner();
const connectivity = new ConnectivityService({
  runner: commandRunner,
  wifiInterface: process.env.NEXUS_WIFI_INTERFACE ?? "wlan0",
  hotspotConnection: process.env.NEXUS_HOTSPOT_CONNECTION ?? "sublim3-hotspot",
});
const systemControl = new SystemControlService({ runner: commandRunner });

const campaignStore = new JsonStore(path.join(dataDirectory, "campaigns"));
const sessionStore = new JsonStore(path.join(dataDirectory, "sessions"));
const characterStore = new JsonStore(path.join(dataDirectory, "characters"));
const systemStore = new JsonStore(path.join(dataDirectory, "systems"));
const accessSessionStore = new JsonStore(path.join(dataDirectory, "access-sessions"));
const audioLibraryStore = new JsonStore(path.join(dataDirectory, "audio", "library"));
const audioStateStore = new JsonStore(path.join(dataDirectory, "audio", "state"));
const playerSettingsStore = new JsonStore(path.join(dataDirectory, "settings"));
const rfidCardStore = new JsonStore(path.join(dataDirectory, "rfid", "cards"));
const rfidStateStore = new JsonStore(path.join(dataDirectory, "rfid", "state"));
const playerSettings = new PlayerSettingsService({ store: playerSettingsStore });
await Promise.all([campaignStore.initialize(), sessionStore.initialize(), characterStore.initialize(), systemStore.initialize(), accessSessionStore.initialize(), audioLibraryStore.initialize(), audioStateStore.initialize(), playerSettings.initialize(), rfidCardStore.initialize(), rfidStateStore.initialize()]);
const initialPlayerSettings = await playerSettings.get();
const usbRoots = process.env.NEXUS_USB_IMPORT_ROOTS
  ? process.env.NEXUS_USB_IMPORT_ROOTS.split(path.delimiter).filter(Boolean)
  : process.platform === "linux" ? ["/media", "/mnt"] : [];
const audioFiles = new AudioFileService({ rootDirectory: path.join(dataDirectory, "audio", "files"), libraryStore: audioLibraryStore, usbRoots });
const audioOutput = process.env.NEXUS_AUDIO_DRIVER === "browser"
  ? new BrowserAudioOutput({ outputDevice: initialPlayerSettings.audio_output_device })
  : new MpvAudioOutput({
      command: process.env.NEXUS_MPV_PATH ?? "/usr/bin/mpv",
      audioDevice: process.env.NEXUS_AUDIO_DEVICE ?? "auto",
      bluetoothAudioDevice: process.env.NEXUS_BLUETOOTH_AUDIO_DEVICE ?? "alsa/bluealsa",
      outputDevice: initialPlayerSettings.audio_output_device,
      cacheDirectory: path.join(dataDirectory, "audio", "cache"),
      bluetoothConnected: async () => (await connectivity.status()).bluetooth.connected_devices.length > 0,
    });
const audio = new AudioService({ libraryStore: audioLibraryStore, stateStore: audioStateStore, files: audioFiles, output: audioOutput, preferences: initialPlayerSettings });
await audio.initialize();
const rfid = new RfidService({ cardStore: rfidCardStore, stateStore: rfidStateStore, audio, settings: () => playerSettings.get() });
await rfid.initialize();
const hardware = shouldStartHardware()
  ? new HardwareInputService({ rfid, audio, settings: () => playerSettings.get() })
  : null;
const expansionPacks = await loadBundledExpansionPacks({ expansionDirectory: expansionSourceDirectory });
for (const { system, preinstalled } of expansionPacks) {
  const existing = await systemStore.get(system.system_id);
  if ((existing?.built_in && existing.version !== system.version) || (!existing && preinstalled)) await systemStore.put(system.system_id, system);
}
for (const character of await characterStore.list()) {
  const campaign = await campaignStore.get(character.campaign_id);
  const system = campaign ? await systemStore.get(campaign.system_id) : null;
  const missingTracker = system?.character_sheet.trackers?.some((tracker) => !character.trackers?.[tracker.tracker_id]);
  if (missingTracker) await characterStore.put(character.character_id, normalizeCharacter(character.campaign_id, applyGameSystemDefaults(character, system), character, system));
}
for (const session of await sessionStore.list()) {
  if (session.mode !== "battle" || !session.battle?.combatants?.length) continue;
  let changed = false;
  const combatants = await Promise.all(session.battle.combatants.map(async (combatant) => {
    if (!combatant.character_id || Object.keys(combatant.trackers ?? {}).length) return combatant;
    const character = await characterStore.get(combatant.character_id);
    if (!character || !Object.keys(character.trackers ?? {}).length) return combatant;
    changed = true;
    return { ...combatant, trackers: character.trackers };
  }));
  if (changed) await sessionStore.put(session.campaign_id, { ...session, battle: { ...session.battle, combatants } });
}
const access = new AccessService({
  sessionStore: accessSessionStore,
  adminPin: process.env.NEXUS_ADMIN_PIN ?? process.env.NEXUS_SETTINGS_PIN ?? "",
  gmPin: process.env.NEXUS_GM_PIN ?? "",
  persistGmPin: process.platform === "linux" ? (pin) => connectivity.runner.runPrivileged("gm-pin", [], `${pin}\n`) : null,
});
const liveEvents = new LiveEvents();

const server = createServer(createApp({
  campaignStore,
  sessionStore,
  characterStore,
  systemStore,
  expansionPacks,
  access,
  liveEvents,
  audio,
  audioPackSourceDirectory: expansionSourceDirectory,
  rfid,
  connectivity,
  systemControl,
  playerSettings,
  getSystemInfo: () => collectSystemInfo(dataDirectory),
}));
server.listen(port, host, () => {
  console.log(`Nexus Core listening on http://${host}:${port}`);
  hardware?.start();
  audio.triggerEffect("system-boot-ready").catch((error) => {
    console.warn(`Boot-ready tone could not be played: ${error.message}`);
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    hardware?.stop();
    server.close(() => process.exit(0));
  });
}
