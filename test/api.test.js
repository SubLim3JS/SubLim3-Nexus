import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../core/src/app.js";
import { JsonStore } from "../core/src/storage/json-store.js";
import { loadBundledExpansionPacks } from "../core/src/expansion-packs.js";
import { AudioService } from "../core/src/audio.js";
import { AudioFileService } from "../core/src/audio-files.js";
import { PlayerSettingsService } from "../core/src/player-settings.js";
import { RfidService } from "../core/src/rfid.js";

let baseUrl;
let server;
let temporaryDirectory;
const connectivityActions = [];
const systemActions = [];

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "nexus-test-"));
  const store = new JsonStore(path.join(temporaryDirectory, "campaigns"));
  const sessionStore = new JsonStore(path.join(temporaryDirectory, "sessions"));
  const characterStore = new JsonStore(path.join(temporaryDirectory, "characters"));
  const systemStore = new JsonStore(path.join(temporaryDirectory, "systems"));
  const audioLibraryStore = new JsonStore(path.join(temporaryDirectory, "audio", "library"));
  const audioStateStore = new JsonStore(path.join(temporaryDirectory, "audio", "state"));
  const playerSettings = new PlayerSettingsService({ store: new JsonStore(path.join(temporaryDirectory, "settings")) });
  await playerSettings.initialize();
  const usbRoot = path.join(temporaryDirectory, "usb");
  await mkdir(usbRoot, { recursive: true });
  await writeFile(path.join(usbRoot, "usb-tone.wav"), Buffer.from("RIFFusb-audio"));
  await writeFile(path.join(temporaryDirectory, "not-on-usb.mp3"), Buffer.from("outside"));
  const audioFiles = new AudioFileService({ rootDirectory: path.join(temporaryDirectory, "audio", "files"), libraryStore: audioLibraryStore, usbRoots: [usbRoot] });
  const audio = new AudioService({ libraryStore: audioLibraryStore, stateStore: audioStateStore, files: audioFiles });
  await audio.initialize();
  const rfid = new RfidService({
    cardStore: new JsonStore(path.join(temporaryDirectory, "rfid", "cards")),
    stateStore: new JsonStore(path.join(temporaryDirectory, "rfid", "state")),
    audio,
    settings: () => playerSettings.get(),
  });
  await rfid.initialize();
  const expansionPacks = await loadBundledExpansionPacks();
  for (const { system, preinstalled } of expansionPacks) if (preinstalled) await systemStore.put(system.system_id, system);
  server = createServer(createApp({
    campaignStore: store,
    sessionStore,
    characterStore,
    systemStore,
    expansionPacks,
    audio,
    rfid,
    playerSettings,
    settingsPin: "123456",
    connectivity: {
      status: async () => ({ supported: true, wifi: { mode: "local", ssid: "SubLim3-Nexus", addresses: ["10.42.0.1/24"] }, bluetooth: { available: true, visible: false, connected_devices: [] } }),
      scanWifi: async () => [{ ssid: "Table WiFi", signal: 88, security: "WPA2" }],
      switchWifi: async (input) => { connectivityActions.push(["wifi", input]); },
      setBluetoothVisible: async (visible) => { connectivityActions.push(["bluetooth", visible]); },
      ping: async (target) => { connectivityActions.push(["ping", target]); return { target, ok: true, output: "64 bytes from test" }; },
    },
    systemControl: {
      shutdown: async () => { systemActions.push("shutdown"); },
      reboot: async () => { systemActions.push("reboot"); },
      update: async () => { systemActions.push("update"); return "Already up to date."; },
    },
    startedAt: new Date(),
    getSystemInfo: async () => ({
      hostname: "nexus-test",
      platform: "test",
      architecture: "arm64",
      node_version: "v20.0.0",
      memory: { total_bytes: 1024, free_bytes: 512 },
      storage: { total_bytes: 2048, free_bytes: 1024 },
    }),
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("reports Nexus Core health", async () => {
  const response = await fetch(`${baseUrl}/api/v1/system/status`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.service, "nexus-core");
  assert.equal(body.version, "1.5.1");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("reports system information", async () => {
  const response = await fetch(`${baseUrl}/api/v1/system/info`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.hostname, "nexus-test");
  assert.equal(body.architecture, "arm64");
  assert.equal(body.storage.free_bytes, 1024);
  assert.equal(body.service, "nexus-core");
});

test("serves the dashboard with secure response headers", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  const page = await response.text();
  assert.match(page, /The table is ready/);
  assert.match(page, /ACCESS &amp; PAIRING/);
  assert.match(page, /class="nav-divider" role="separator"/);
  assert.match(page, /Connect Owner Console/);
  assert.match(page, /href="\/gm\/"/);
  const adminScript = await fetch(`${baseUrl}/assets/app.js`).then((asset) => asset.text());
  assert.match(adminScript, /\[401, 403\]\.includes\(error\.status\)/);
  assert.match(adminScript, /some data could not be loaded/);
});

test("serves the Nexus logo asset", async () => {
  const response = await fetch(`${baseUrl}/assets/nexus-logo.png`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.ok(Number(response.headers.get("content-length")) > 100_000);
});

test("protects connectivity controls with the Settings PIN", async () => {
  assert.equal((await fetch(`${baseUrl}/api/v1/connectivity/status`)).status, 401);
  const status = await fetch(`${baseUrl}/api/v1/connectivity/status`, { headers: { "x-nexus-settings-pin": "123456" } }).then((response) => response.json());
  assert.equal(status.data.wifi.mode, "local");
  assert.equal((await fetch(`${baseUrl}/api/v1/connectivity/wifi/networks`)).status, 401);

  const networks = await fetch(`${baseUrl}/api/v1/connectivity/wifi/networks`, { headers: { "x-nexus-settings-pin": "123456" } }).then((response) => response.json());
  assert.equal(networks.data[0].ssid, "Table WiFi");

  const switched = await fetch(`${baseUrl}/api/v1/connectivity/wifi/mode`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-nexus-settings-pin": "123456" },
    body: JSON.stringify({ mode: "local" }),
  });
  assert.equal(switched.status, 202);
  assert.deepEqual(connectivityActions.at(-1), ["wifi", { mode: "local" }]);

  const ping = await fetch(`${baseUrl}/api/v1/connectivity/tools/ping`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-nexus-settings-pin": "123456" },
    body: JSON.stringify({ target: "192.168.1.1" }),
  }).then((response) => response.json());
  assert.equal(ping.data.ok, true);
  assert.deepEqual(connectivityActions.at(-1), ["ping", "192.168.1.1"]);
});

test("serves the connectivity Settings page", async () => {
  const response = await fetch(`${baseUrl}/settings/`);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /Bluetooth visibility/);
  assert.match(page, />Update<\/button>/);
  assert.match(page, /Playback defaults/);
  assert.match(page, /Card behavior/);
  assert.match(page, /Network tools/);
  assert.match(page, /class="nav-item active" href="\/settings\/"/);
  assert.match(page, /href="\/controllers\/"/);
  assert.match(page, /href="\/library\/"/);
  const script = await fetch(`${baseUrl}/assets/settings.js`).then((asset) => asset.text());
  assert.match(script, /sessionStorage\.setItem\(UPDATE_NOTICE_KEY/);
  assert.match(script, /window\.location\.replace/);
  assert.match(script, /window\.scrollTo\(0,0\)/);
  assert.match(script, /Update succeeded\. Nexus Core v/);
  assert.match(script, /connectivity\/tools\/ping/);
});

test("protects and persists player settings", async () => {
  assert.equal((await fetch(`${baseUrl}/api/v1/settings/player`)).status, 401);
  const settings = await fetch(`${baseUrl}/api/v1/settings/player`, { headers:{ "x-nexus-settings-pin":"123456" } }).then((response) => response.json());
  assert.equal(settings.data.volume_step, 5);
  assert.equal(settings.data.rfid_second_scan, "toggle");

  const updated = await fetch(`${baseUrl}/api/v1/settings/player`, {
    method:"PUT", headers:{ "content-type":"application/json", "x-nexus-settings-pin":"123456" },
    body:JSON.stringify({ maximum_volume:70, startup_volume:60, volume_step:10, stop_playout_minutes:15, rfid_scan_mode:"place" }),
  }).then((response) => response.json());
  assert.equal(updated.data.maximum_volume, 70);
  assert.equal(updated.data.rfid_scan_mode, "place");
  assert.equal((await fetch(`${baseUrl}/api/v1/audio/volume`, { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ volume:80 }) })).status, 422);
});

test("protects and delegates system controls", async () => {
  assert.equal((await fetch(`${baseUrl}/api/v1/system/reboot`, { method: "POST" })).status, 401);
  for (const action of ["shutdown", "reboot", "update"]) {
    const response = await fetch(`${baseUrl}/api/v1/system/${action}`, {
      method: "POST",
      headers: { "x-nexus-settings-pin": "123456" },
    });
    assert.equal(response.status, 202);
  }
  assert.deepEqual(systemActions, ["shutdown", "reboot", "update"]);
});

test("serves the offline media player demo", async () => {
  const response = await fetch(`${baseUrl}/media/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const page = await response.text();
  assert.match(page, /Soundscapes/);
  assert.match(page, /Media Library/);
  assert.match(page, /Live radio/);
  assert.match(page, /Search audio/);
  assert.doesNotMatch(page, /Assign a card/);
  assert.doesNotMatch(page, /Create folder/);
  assert.match(page, /Local · USB · Live/);
  assert.match(page, /stream\.revma\.ihrhls\.com\/zc2157/);
  assert.match(response.headers.get("content-security-policy"), /media-src 'self' http: https:/);
});

test("serves Expansion Packs on a dedicated management page", async () => {
  const overview = await fetch(`${baseUrl}/`).then((response) => response.text());
  assert.match(overview, /href="\/packs\/"/);
  assert.match(overview, /Manage Expansion Packs/);
  assert.doesNotMatch(overview, /id="system-list"/);

  const response = await fetch(`${baseUrl}/packs/`);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /class="nav-item active" href="\/packs\/"/);
  assert.match(page, /Choose what your table needs/);
  assert.match(page, /id="system-list"/);
  assert.equal((await fetch(`${baseUrl}/assets/packs.js`)).status, 200);
});

test("serves separate RFID and media library management pages", async () => {
  const rfidPage = await fetch(`${baseUrl}/rfid/`).then((response) => response.text());
  assert.match(rfidPage, /RFID Cards/);
  assert.match(rfidPage, /Assign a card/);
  assert.match(rfidPage, /Use last scan/);
  assert.match(rfidPage, /href="\/media\/"/);
  assert.doesNotMatch(rfidPage, /Create folder/);

  const libraryPage = await fetch(`${baseUrl}/library/`).then((response) => response.text());
  assert.match(libraryPage, /Media Library/);
  assert.match(libraryPage, /Create folder/);
  assert.match(libraryPage, /Scan USB/);
  assert.match(libraryPage, /href="\/rfid\/"/);
  assert.doesNotMatch(libraryPage, /Assign a card/);

  for (const asset of ["manage.css", "rfid.js", "library.js"]) assert.equal((await fetch(`${baseUrl}/assets/${asset}`)).status, 200);
});

test("serves the GM campaign invitation surface", async () => {
  const response = await fetch(`${baseUrl}/gm/`);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /Scan to join this campaign/);
  assert.match(page, /gm-player-qr/);
  assert.match(page, /class="nav-item active" href="\/gm\/"/);
  assert.match(page, /Owner devices open the console automatically/);
  const gmScript = await fetch(`${baseUrl}/assets/gm.js`).then((asset) => asset.text());
  assert.match(gmScript, /nexus-admin-token/);
  assert.match(gmScript, /identity\.role/);
  const module = await fetch(`${baseUrl}/assets/qr.js`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get("content-type"), /javascript/);
});

test("serves the Player Controllers management page", async () => {
  const response = await fetch(`${baseUrl}/controllers/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const page = await response.text();
  assert.match(page, /Player Controllers/);
  assert.match(page, /Paired controllers/);
  assert.match(page, /class="nav-item active" href="\/controllers\/"/);
  assert.match(page, /href="\/rfid\/"/);
  assert.match(page, /href="\/library\/"/);
  assert.equal((await fetch(`${baseUrl}/assets/controllers.js`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/assets/controllers.css`)).status, 200);
});

test("manages the persistent audio library and playback state", async () => {
  const library = await fetch(`${baseUrl}/api/v1/audio/library`).then((response) => response.json());
  assert.equal(library.data.filter((item) => item.kind === "ambience").length, 3);
  assert.equal(library.data.filter((item) => item.kind === "effect").length, 4);

  const played = await fetch(`${baseUrl}/api/v1/audio/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item_id: "understone-hollow" }),
  }).then((response) => response.json());
  assert.equal(played.data.state, "playing");
  assert.equal(played.data.item.name, "Understone Hollow");

  const volume = await fetch(`${baseUrl}/api/v1/audio/volume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ volume: 37 }),
  }).then((response) => response.json());
  assert.equal(volume.data.volume, 37);

  const effect = await fetch(`${baseUrl}/api/v1/audio/effects/thunder/trigger`, { method: "POST" }).then((response) => response.json());
  assert.equal(effect.data.last_effect.item_id, "thunder");
  assert.ok(effect.data.last_effect.event_id);

  const paused = await fetch(`${baseUrl}/api/v1/audio/pause`, { method: "POST" }).then((response) => response.json());
  assert.equal(paused.data.state, "paused");
  assert.ok(paused.data.position_seconds >= 0);
  const stopped = await fetch(`${baseUrl}/api/v1/audio/stop`, { method: "POST" }).then((response) => response.json());
  assert.equal(stopped.data.state, "stopped");
  assert.equal(stopped.data.position_seconds, 0);

  const missing = await fetch(`${baseUrl}/api/v1/audio/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item_id: "missing" }),
  });
  assert.equal(missing.status, 404);

  const radio = await fetch(`${baseUrl}/api/v1/audio/radio/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Table Radio", url: "https://stream.example.com/live" }),
  }).then((response) => response.json());
  assert.equal(radio.data.state, "playing");
  assert.equal(radio.data.item.name, "Table Radio");
  assert.equal(radio.data.item.source.type, "radio");
  assert.equal(radio.data.item.source.stream_url, "https://stream.example.com/live");

  const unsafeRadio = await fetch(`${baseUrl}/api/v1/audio/radio/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Unsafe", url: "file:///etc/passwd" }),
  });
  assert.equal(unsafeRadio.status, 422);
});

test("binds RFID cards to audio actions and records scans", async () => {
  const assigned = await fetch(`${baseUrl}/api/v1/rfid/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: "04:A1-B2 C3", name: "Tavern card", action: { type: "audio", item_id: "lantern-and-oak" } }),
  });
  assert.equal(assigned.status, 201);
  assert.equal((await assigned.json()).data.uid, "04a1b2c3");

  const cards = await fetch(`${baseUrl}/api/v1/rfid/cards`).then((response) => response.json());
  assert.equal(cards.data.length, 1);
  assert.equal(cards.data[0].action.item_id, "lantern-and-oak");

  const scan = await fetch(`${baseUrl}/api/v1/rfid/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: "04a1b2c3" }),
  }).then((response) => response.json());
  assert.equal(scan.data.outcome, "executed");
  assert.equal(scan.data.audio.state, "playing");
  assert.equal(scan.data.audio.item_id, "lantern-and-oak");

  const repeated = await fetch(`${baseUrl}/api/v1/rfid/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: "04a1b2c3" }),
  }).then((response) => response.json());
  assert.equal(repeated.data.outcome, "ignored_delay");

  const released = await fetch(`${baseUrl}/api/v1/rfid/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: "04a1b2c3", present: false }),
  }).then((response) => response.json());
  assert.equal(released.data.outcome, "released");
  assert.equal(released.data.audio.state, "stopped");

  const lastScan = await fetch(`${baseUrl}/api/v1/rfid/last-scan`).then((response) => response.json());
  assert.equal(lastScan.data.uid, "04a1b2c3");
  assert.equal(lastScan.data.present, false);

  const missingAudio = await fetch(`${baseUrl}/api/v1/rfid/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uid: "deadbeef", name: "Missing", action: { type: "audio", item_id: "not-there" } }),
  });
  assert.equal(missingAudio.status, 404);

  assert.equal((await fetch(`${baseUrl}/api/v1/rfid/cards/04a1b2c3`, { method: "DELETE" })).status, 204);
  assert.equal((await fetch(`${baseUrl}/api/v1/rfid/cards/04a1b2c3`, { method: "DELETE" })).status, 404);
  const emptyCards = await fetch(`${baseUrl}/api/v1/rfid/cards`).then((response) => response.json());
  assert.equal(emptyCards.data.length, 0);
});

test("uploads, organizes, streams, and imports audio files", async () => {
  const createdFolder = await fetch(`${baseUrl}/api/v1/audio/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Taverns" }),
  }).then((response) => response.json());
  assert.equal(createdFolder.data.folder_path, "Taverns");

  const bytes = Buffer.from("RIFFbrowser-audio");
  const uploadResponse = await fetch(`${baseUrl}/api/v1/audio/files/upload?filename=busy_inn.wav&folder=Taverns&kind=ambience`, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: bytes,
  });
  assert.equal(uploadResponse.status, 201);
  const uploaded = (await uploadResponse.json()).data;
  assert.equal(uploaded.name, "busy inn");
  assert.equal(uploaded.folder_path, "Taverns");
  assert.equal(uploaded.source.size_bytes, bytes.length);

  const streamed = await fetch(`${baseUrl}/api/v1/audio/files/${uploaded.item_id}/content`);
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await streamed.arrayBuffer()), bytes);
  const ranged = await fetch(`${baseUrl}/api/v1/audio/files/${uploaded.item_id}/content`, { headers: { range: "bytes=0-3" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 0-3/${bytes.length}`);
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), "RIFF");
  const suffix = await fetch(`${baseUrl}/api/v1/audio/files/${uploaded.item_id}/content`, { headers: { range: "bytes=-5" } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-5));

  await fetch(`${baseUrl}/api/v1/audio/folders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Battle" }) });
  const moved = await fetch(`${baseUrl}/api/v1/audio/files/${uploaded.item_id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folder_path: "Battle" }),
  }).then((response) => response.json());
  assert.equal(moved.data.folder_path, "Battle");

  const usb = await fetch(`${baseUrl}/api/v1/audio/usb`).then((response) => response.json());
  assert.equal(usb.data.length, 1);
  assert.equal(usb.data[0].name, "usb-tone.wav");
  const usbPlayback = await fetch(`${baseUrl}/api/v1/audio/usb/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source_path: usb.data[0].source_path }),
  }).then((response) => response.json());
  assert.equal(usbPlayback.data.state, "playing");
  assert.equal(usbPlayback.data.item.source.type, "usb");
  const directUsb = await fetch(`${baseUrl}/api/v1/audio/usb/${usbPlayback.data.item_id}/content`);
  assert.deepEqual(Buffer.from(await directUsb.arrayBuffer()), Buffer.from("RIFFusb-audio"));
  const imported = await fetch(`${baseUrl}/api/v1/audio/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source_path: usb.data[0].source_path, folder_path: "Taverns", kind: "ambience" }),
  }).then((response) => response.json());
  assert.equal(imported.data.folder_path, "Taverns");
  assert.equal(imported.data.source.original_filename, "usb-tone.wav");

  const outsideUsb = await fetch(`${baseUrl}/api/v1/audio/usb/play`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source_path: path.join(temporaryDirectory, "not-on-usb.mp3") }),
  });
  assert.equal(outsideUsb.status, 403);
  const stoppedUsb = await fetch(`${baseUrl}/api/v1/audio/stop`, { method: "POST" }).then((response) => response.json());
  assert.equal(stoppedUsb.data.item_id, null);
  assert.equal(stoppedUsb.data.item, null);

  const traversal = await fetch(`${baseUrl}/api/v1/audio/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "../escape" }),
  });
  assert.equal(traversal.status, 422);
});

test("manages versioned game-system and character-sheet templates", async () => {
  const initialSystems = await fetch(`${baseUrl}/api/v1/systems`).then((response) => response.json());
  assert.deepEqual(initialSystems.data.map((system) => system.system_id), ["custom"]);
  const custom = initialSystems.data[0];
  assert.equal(custom.character_sheet.presets.length, 8);
  assert.deepEqual(new Set(custom.character_sheet.presets.map((preset) => preset.archetype)), new Set(["Warrior", "Rogue", "Mage", "Healer"]));
  const initialCatalog = await fetch(`${baseUrl}/api/v1/packs`).then((response) => response.json());
  assert.equal(initialCatalog.data.length, 8);
  assert.equal(initialCatalog.data.filter((pack) => pack.installed).length, 1);
  assert.equal(initialCatalog.data.find((pack) => pack.pack_id === "custom").preinstalled, true);
  assert.equal(initialCatalog.data.find((pack) => pack.pack_id === "custom").experience, "quick_start");
  assert.equal((await fetch(`${baseUrl}/api/v1/packs/custom`, { method: "DELETE" })).status, 409);
  assert.equal((await fetch(`${baseUrl}/api/v1/packs/missing/install`, { method: "POST" })).status, 404);

  assert.equal((await fetch(`${baseUrl}/api/v1/packs/dnd5e/install`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/v1/packs/d20-fantasy/install`, { method: "POST" })).status, 200);
  const installedSystems = await fetch(`${baseUrl}/api/v1/systems`).then((response) => response.json());
  assert.deepEqual(installedSystems.data.map((system) => system.system_id).sort(), ["custom", "d20-fantasy", "dnd5e"]);
  const dnd = installedSystems.data.find((system) => system.system_id === "dnd5e");
  assert.equal(dnd.version, "1.2");
  assert.equal(dnd.character_sheet.pages[0].page_id, "status");
  assert.equal(dnd.character_sheet.trackers[0].tracker_id, "death_saves");
  assert.ok(dnd.character_sheet.pages[0].bindings.includes("death_saves"));
  await fetch(`${baseUrl}/api/v1/campaigns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ campaign_id: "optional_pack_test", name: "Optional Pack", system_id: "d20-fantasy" }) });
  assert.equal((await fetch(`${baseUrl}/api/v1/packs/d20-fantasy`, { method: "DELETE" })).status, 409);
  await fetch(`${baseUrl}/api/v1/campaigns/optional_pack_test`, { method: "DELETE" });
  assert.equal((await fetch(`${baseUrl}/api/v1/packs/d20-fantasy`, { method: "DELETE" })).status, 204);
  const unknownCampaign = await fetch(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "unknown_system", name: "Unknown", system_id: "missing" }),
  });
  assert.equal(unknownCampaign.status, 422);

  const created = await fetch(`${baseUrl}/api/v1/systems`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_id: "starward",
      name: "Starward",
      version: "0.1",
      description: "A compact science-fantasy template.",
      character_sheet: {
        fields: [{ field_id: "rank", label: "Rank", type: "number", default_value: 2 }],
        resources: [{ resource_id: "resolve", label: "Resolve", default_current: 3, default_maximum: 5 }],
        conditions: ["Exposed"],
        pages: [{ page_id: "status", title: "Status", bindings: ["resolve", "rank", "unknown"] }],
        actions: [{ action_id: "spend_resolve", label: "Spend Resolve", kind: "decrement", target: "resolve" }],
      },
    }),
  });
  assert.equal(created.status, 201);
  const system = (await created.json()).data;
  assert.deepEqual(system.character_sheet.pages[0].bindings, ["resolve", "rank"]);

  await fetch(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "starward_test", name: "Starward Test", system_id: "starward" }),
  });
  const character = await fetch(`${baseUrl}/api/v1/campaigns/starward_test/characters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ character_id: "nova", character_name: "Nova" }),
  }).then((response) => response.json());
  assert.equal(character.data.system_id, "starward");
  assert.equal(character.data.template_version, "0.1");
  assert.equal(character.data.fields.rank, 2);
  assert.equal(character.data.resources.resolve.maximum, 5);
  assert.equal((await fetch(`${baseUrl}/api/v1/systems/starward`, { method: "DELETE" })).status, 409);
  await fetch(`${baseUrl}/api/v1/campaigns/starward_test/characters/nova`, { method: "DELETE" });
  await fetch(`${baseUrl}/api/v1/campaigns/starward_test`, { method: "DELETE" });
  assert.equal((await fetch(`${baseUrl}/api/v1/systems/starward`, { method: "DELETE" })).status, 204);

  const scratch = await fetch(`${baseUrl}/api/v1/systems`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ system_id: "scratch", name: "Scratch", character_sheet: {} }),
  });
  assert.equal(scratch.status, 201);
  assert.equal((await fetch(`${baseUrl}/api/v1/systems/scratch`, { method: "DELETE" })).status, 204);
});

test("runs template-defined D&D death saves and syncs the character", async () => {
  await fetch(`${baseUrl}/api/v1/packs/dnd5e/install`, { method: "POST" });
  await fetch(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "death_save_test", name: "Death Save Test", system_id: "dnd5e" }),
  });
  const character = await fetch(`${baseUrl}/api/v1/campaigns/death_save_test/characters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ character_id: "fallen_hero", character_name: "Fallen Hero", resources: { health: { label: "Hit Points", current: 0, maximum: 10 } } }),
  }).then((response) => response.json());
  assert.equal(character.data.trackers.death_saves.success_target, 3);
  assert.equal(character.data.trackers.death_saves.failures, 0);

  await fetch(`${baseUrl}/api/v1/campaigns/death_save_test/session`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "battle", scene: {}, battle: { combatants: [{ combatant_id: "character_fallen_hero", character_id: "fallen_hero", source: "character", name: "Fallen Hero", initiative: 10, health: character.data.resources.health, trackers: character.data.trackers }] } }),
  });
  async function trackerAction(action) {
    return fetch(`${baseUrl}/api/v1/campaigns/death_save_test/battle/combatants/character_fallen_hero`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tracker_action: { tracker_id: "death_saves", action } }),
    }).then((response) => response.json());
  }
  await trackerAction("success"); await trackerAction("success");
  const stabilized = await trackerAction("success");
  assert.equal(stabilized.data.battle.combatants[0].trackers.death_saves.status, "stabilized");

  await trackerAction("reset");
  const naturalOne = await trackerAction("critical_failure");
  assert.equal(naturalOne.data.battle.combatants[0].trackers.death_saves.failures, 2);
  const dead = await trackerAction("failure");
  assert.equal(dead.data.battle.combatants[0].trackers.death_saves.status, "dead");

  await trackerAction("reset");
  const naturalTwenty = await trackerAction("critical_success");
  assert.equal(naturalTwenty.data.battle.combatants[0].health.current, 1);
  assert.equal(naturalTwenty.data.battle.combatants[0].trackers.death_saves.successes, 0);
  const synced = await fetch(`${baseUrl}/api/v1/campaigns/death_save_test/characters/fallen_hero`).then((response) => response.json());
  assert.equal(synced.data.resources.health.current, 1);
  assert.equal(synced.data.trackers.death_saves.status, "active");

  await fetch(`${baseUrl}/api/v1/campaigns/death_save_test/characters/fallen_hero`, { method: "DELETE" });
  await fetch(`${baseUrl}/api/v1/campaigns/death_save_test`, { method: "DELETE" });
});

test("creates a Custom RPG hero from a quick-start preset", async () => {
  const systems = await fetch(`${baseUrl}/api/v1/systems`).then((response) => response.json());
  const custom = systems.data.find((system) => system.system_id === "custom");
  const preset = custom.character_sheet.presets.find((item) => item.preset_id === "mage_female");
  await fetch(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "quick_start_test", name: "Quick Start", system_id: "custom" }),
  });
  const created = await fetch(`${baseUrl}/api/v1/campaigns/quick_start_test/characters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ character_id: "elara", character_name: preset.suggested_name, fields: preset.fields, resources: preset.resources }),
  }).then((response) => response.json());
  assert.equal(created.data.fields.role, "Mage");
  assert.equal(created.data.fields.defense, 11);
  assert.equal(created.data.resources.health.maximum, 8);
  assert.equal(created.data.template_version, "1.1");
  await fetch(`${baseUrl}/api/v1/campaigns/quick_start_test/characters/elara`, { method: "DELETE" });
  await fetch(`${baseUrl}/api/v1/campaigns/quick_start_test`, { method: "DELETE" });
});

test("creates, reads, updates, lists, and deletes campaign characters", async () => {
  await fetch(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "character_test", name: "Character Test", system_id: "custom" }),
  });
  const created = await fetch(`${baseUrl}/api/v1/campaigns/character_test/characters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      character_id: "nyra_vale",
      character_name: "Nyra Vale",
      player_name: "Jordan",
      fields: { role: "Warden", level: 3 },
      resources: { health: { label: "Health", current: 18, maximum: 24 } },
      conditions: ["Inspired"],
    }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).data.resources.health.maximum, 24);

  const list = await fetch(`${baseUrl}/api/v1/campaigns/character_test/characters`).then((response) => response.json());
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].character_name, "Nyra Vale");

  const updated = await fetch(`${baseUrl}/api/v1/campaigns/character_test/characters/nyra_vale`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ character_name: "Nyra Vale", fields: { role: "Warden", level: 4 }, resources: { health: { label: "Health", current: 21, maximum: 28 } }, conditions: [] }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.fields.level, 4);

  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns/missing/characters/nyra_vale`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns/character_test/characters/nyra_vale`, { method: "DELETE" })).status, 204);
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns/character_test/characters/nyra_vale`)).status, 404);
});

test("validates character input and serves the player view", async () => {
  const invalid = await fetch(`${baseUrl}/api/v1/campaigns/character_test/characters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ character_id: "Bad ID" }),
  });
  assert.equal(invalid.status, 422);
  const invalidBody = await fetch(`${baseUrl}/api/v1/campaigns/character_test/characters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  });
  assert.equal(invalidBody.status, 422);
  const playerPage = await fetch(`${baseUrl}/player/`);
  assert.equal(playerPage.status, 200);
  assert.match(await playerPage.text(), /PLAYER VIEW/);
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns/character_test`, { method: "DELETE" })).status, 204);
});

test("temporarily locks connectivity controls after repeated bad PINs", async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/v1/connectivity/status`, { headers: { "x-nexus-settings-pin": "wrong" } });
    assert.equal(response.status, 401);
  }
  const blocked = await fetch(`${baseUrl}/api/v1/connectivity/status`, { headers: { "x-nexus-settings-pin": "123456" } });
  assert.equal(blocked.status, 429);
});

test("creates, lists, updates, and deletes a campaign", async () => {
  const created = await fetch(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "lost_mines", name: "Lost Mines", system_id: "dnd5e" }),
  });
  assert.equal(created.status, 201);

  const list = await fetch(`${baseUrl}/api/v1/campaigns`).then((response) => response.json());
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].campaign_id, "lost_mines");

  const updated = await fetch(`${baseUrl}/api/v1/campaigns/lost_mines`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Lost Mine of Phandelver", system_id: "dnd5e", active: true }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.active, true);

  const removed = await fetch(`${baseUrl}/api/v1/campaigns/lost_mines`, { method: "DELETE" });
  assert.equal(removed.status, 204);
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns/lost_mines`)).status, 404);
});

test("rejects invalid campaign input", async () => {
  const response = await fetch(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "Invalid ID" }),
  });
  assert.equal(response.status, 422);
});

test("runs a system-neutral battle session", async () => {
  await fetch(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaign_id: "battle_test", name: "Battle Test", system_id: "custom" }),
  });

  const initial = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/session`).then((response) => response.json());
  assert.equal(initial.data.mode, "game");
  assert.equal(initial.data.battle.round, 0);

  const saved = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/session`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "battle",
      scene: { title: "The Broken Gate", description: "Rain lashes the old stones." },
      battle: {
        combatants: [
          { combatant_id: "goblin", name: "Goblin", initiative: 12 },
          { combatant_id: "hero", name: "Hero", initiative: 18 },
        ],
      },
    }),
  }).then((response) => response.json());
  assert.equal(saved.data.battle.round, 1);
  assert.equal(saved.data.battle.combatants[0].combatant_id, "hero");

  const next = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/battle/next`, { method: "POST" }).then((response) => response.json());
  assert.equal(next.data.battle.turn_index, 1);
  const wrapped = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/battle/next`, { method: "POST" }).then((response) => response.json());
  assert.equal(wrapped.data.battle.turn_index, 0);
  assert.equal(wrapped.data.battle.round, 2);

  const previous = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/battle/previous`, { method: "POST" }).then((response) => response.json());
  assert.equal(previous.data.battle.turn_index, 1);
  assert.equal(previous.data.battle.round, 1);
  const resetRoundResult = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/battle/round/reset`, { method: "POST" }).then((response) => response.json());
  assert.equal(resetRoundResult.data.battle.turn_index, 0);
  assert.equal(resetRoundResult.data.battle.round, 1);

  const edited = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/battle/combatants/hero`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initiative: 5 }),
  }).then((response) => response.json());
  assert.equal(edited.data.battle.combatants[0].initiative, 5);
  const reordered = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/battle/reorder`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ combatant_ids: ["goblin", "hero"] }),
  }).then((response) => response.json());
  assert.equal(reordered.data.battle.combatants[0].combatant_id, "goblin");
  assert.equal(reordered.data.battle.combatants[reordered.data.battle.turn_index].combatant_id, "hero");

  const added = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/battle/combatants`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ combatant_id: "ogre", name: "Ogre", initiative: 30 }),
  }).then((response) => response.json());
  assert.equal(added.data.battle.combatants[0].combatant_id, "ogre");
  assert.equal(added.data.battle.combatants[added.data.battle.turn_index].combatant_id, "hero");
  const removedCombatant = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/battle/combatants/goblin`, { method: "DELETE" }).then((response) => response.json());
  assert.deepEqual(removedCombatant.data.battle.combatants.map((combatant) => combatant.combatant_id), ["ogre", "hero"]);
  assert.equal(removedCombatant.data.battle.combatants[removedCombatant.data.battle.turn_index].combatant_id, "hero");

  await fetch(`${baseUrl}/api/v1/campaigns/battle_test/characters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ character_id: "battle_hero", character_name: "Battle Hero", resources: { health: { label: "Health", current: 10, maximum: 10 } }, conditions: [] }),
  });
  await fetch(`${baseUrl}/api/v1/campaigns/battle_test/session`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "battle", scene: {}, battle: { combatants: [{ combatant_id: "character_battle_hero", character_id: "battle_hero", source: "character", name: "Battle Hero", initiative: 20, health: { current: 10, maximum: 10 } }] } }),
  });
  const damaged = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/battle/combatants/character_battle_hero`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ health_change: -4, conditions: ["Poisoned"] }),
  }).then((response) => response.json());
  assert.equal(damaged.data.battle.combatants[0].health.current, 6);
  assert.deepEqual(damaged.data.battle.combatants[0].conditions, ["Poisoned"]);
  const syncedCharacter = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/characters/battle_hero`).then((response) => response.json());
  assert.equal(syncedCharacter.data.resources.health.current, 6);
  assert.deepEqual(syncedCharacter.data.conditions, ["Poisoned"]);
  const playerAdjusted = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/characters/battle_hero/resources/health/adjust`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delta: 2 }),
  }).then((response) => response.json());
  assert.equal(playerAdjusted.data.resources.health.current, 8);
  const adjustedSession = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/session`).then((response) => response.json());
  assert.equal(adjustedSession.data.battle.combatants[0].health.current, 8);
  const ended = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/battle/end`, { method: "POST" }).then((response) => response.json());
  assert.equal(ended.data.mode, "game");
  assert.equal(ended.data.battle.combatants.length, 0);
  const reset = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/session/reset`, { method: "POST" }).then((response) => response.json());
  assert.equal(reset.data.scene.title, "");
  assert.equal(reset.data.battle.round, 0);
});
