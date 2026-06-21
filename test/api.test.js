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
  server = createServer(createApp({ campaignStore: store, startedAt: new Date() }));
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

