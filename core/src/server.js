import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { JsonStore } from "./storage/json-store.js";
import { collectSystemInfo } from "./system-info.js";
import { CommandRunner } from "./platform/command-runner.js";
import { ConnectivityService } from "./platform/connectivity.js";
import { AccessService } from "./access.js";
import { LiveEvents } from "./live-events.js";
import { BUILT_IN_GAME_SYSTEMS } from "./game-system.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.NEXUS_DATA_DIR ?? path.resolve(directory, "../data");
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const connectivity = new ConnectivityService({
  runner: new CommandRunner(),
  wifiInterface: process.env.NEXUS_WIFI_INTERFACE ?? "wlan0",
  hotspotConnection: process.env.NEXUS_HOTSPOT_CONNECTION ?? "sublim3-hotspot",
});

const campaignStore = new JsonStore(path.join(dataDirectory, "campaigns"));
const sessionStore = new JsonStore(path.join(dataDirectory, "sessions"));
const characterStore = new JsonStore(path.join(dataDirectory, "characters"));
const systemStore = new JsonStore(path.join(dataDirectory, "systems"));
const accessSessionStore = new JsonStore(path.join(dataDirectory, "access-sessions"));
await Promise.all([campaignStore.initialize(), sessionStore.initialize(), characterStore.initialize(), systemStore.initialize(), accessSessionStore.initialize()]);
for (const system of BUILT_IN_GAME_SYSTEMS) if (!await systemStore.get(system.system_id)) await systemStore.put(system.system_id, system);
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
  access,
  liveEvents,
  connectivity,
  getSystemInfo: () => collectSystemInfo(dataDirectory),
}));
server.listen(port, host, () => {
  console.log(`Nexus Core listening on http://${host}:${port}`);
});
