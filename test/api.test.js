import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../core/src/app.js";
import { JsonStore } from "../core/src/storage/json-store.js";

let baseUrl;
let server;
let temporaryDirectory;
const connectivityActions = [];

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "nexus-test-"));
  const store = new JsonStore(path.join(temporaryDirectory, "campaigns"));
  const sessionStore = new JsonStore(path.join(temporaryDirectory, "sessions"));
  const characterStore = new JsonStore(path.join(temporaryDirectory, "characters"));
  server = createServer(createApp({
    campaignStore: store,
    sessionStore,
    characterStore,
    settingsPin: "123456",
    connectivity: {
      status: async () => ({ supported: true, wifi: { mode: "local", ssid: "SubLim3-Nexus", addresses: ["10.42.0.1/24"] }, bluetooth: { available: true, visible: false, connected_devices: [] } }),
      scanWifi: async () => [{ ssid: "Table WiFi", signal: 88, security: "WPA2" }],
      switchWifi: async (input) => { connectivityActions.push(["wifi", input]); },
      setBluetoothVisible: async (visible) => { connectivityActions.push(["bluetooth", visible]); },
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
});

test("serves the connectivity Settings page", async () => {
  const response = await fetch(`${baseUrl}/settings/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Bluetooth visibility/);
});

test("serves the offline media player demo", async () => {
  const response = await fetch(`${baseUrl}/media/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const page = await response.text();
  assert.match(page, /Soundscapes/);
  assert.match(page, /Browser preview/);
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
  const ended = await fetch(`${baseUrl}/api/v1/campaigns/battle_test/battle/end`, { method: "POST" }).then((response) => response.json());
  assert.equal(ended.data.mode, "game");
  assert.equal(ended.data.battle.combatants.length, 0);
});
