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

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "nexus-test-"));
  const store = new JsonStore(path.join(temporaryDirectory, "campaigns"));
  const sessionStore = new JsonStore(path.join(temporaryDirectory, "sessions"));
  server = createServer(createApp({
    campaignStore: store,
    sessionStore,
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
  assert.match(await response.text(), /The table is ready/);
});

test("serves the Nexus logo asset", async () => {
  const response = await fetch(`${baseUrl}/assets/nexus-logo.png`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.ok(Number(response.headers.get("content-length")) > 100_000);
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
});
