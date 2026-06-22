import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { AccessService } from "../core/src/access.js";
import { createApp } from "../core/src/app.js";
import { JsonStore } from "../core/src/storage/json-store.js";

let baseUrl;
let server;
let temporaryDirectory;
let gmToken;
let persistedGmPin = "222222";

function bearer(token) { return { authorization: `Bearer ${token}` }; }
async function pair(input) {
  const response = await fetch(`${baseUrl}/api/v1/auth/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return { response, body: await response.json() };
}

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "nexus-access-test-"));
  const campaignStore = new JsonStore(path.join(temporaryDirectory, "campaigns"));
  const sessionStore = new JsonStore(path.join(temporaryDirectory, "sessions"));
  const characterStore = new JsonStore(path.join(temporaryDirectory, "characters"));
  const accessSessionStore = new JsonStore(path.join(temporaryDirectory, "access-sessions"));
  await campaignStore.put("green_realm", { campaign_id: "green_realm", name: "Green Realm", system_id: "custom" });
  await campaignStore.put("red_realm", { campaign_id: "red_realm", name: "Red Realm", system_id: "custom" });
  await characterStore.put("nyra", { character_id: "nyra", campaign_id: "green_realm", character_name: "Nyra", player_name: "Jordan", fields: {}, resources: {}, conditions: [], public_notes: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  await characterStore.put("orin", { character_id: "orin", campaign_id: "green_realm", character_name: "Orin", player_name: "Sam", fields: {}, resources: {}, conditions: [], public_notes: "", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const access = new AccessService({ sessionStore: accessSessionStore, adminPin: "111111", gmPin: "222222", persistGmPin: async (pin) => { persistedGmPin = pin; } });
  server = createServer(createApp({ campaignStore, sessionStore, characterStore, access }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("exposes discovery while protecting administrative APIs", async () => {
  assert.equal((await fetch(`${baseUrl}/api/v1/discovery/campaigns`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns`)).status, 401);
  assert.equal((await pair({ role: "admin", pin: "wrong" })).response.status, 401);
  const admin = await pair({ role: "admin", pin: "111111" });
  assert.equal(admin.response.status, 201);
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns`, { headers: bearer(admin.body.token) })).status, 200);
  const sessions = await fetch(`${baseUrl}/api/v1/auth/sessions`, { headers: bearer(admin.body.token) }).then((response) => response.json());
  assert.equal(sessions.data[0].role, "admin");
});

test("scopes GM access to one campaign and permits table mutations", async () => {
  const gm = await pair({ role: "gm", pin: "222222", campaign_id: "green_realm", device_name: "GM tablet" });
  assert.equal(gm.response.status, 201);
  gmToken = gm.body.token;
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns/green_realm`, { headers: bearer(gm.body.token) })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns/red_realm`, { headers: bearer(gm.body.token) })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns`, { headers: bearer(gm.body.token) })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/v1/auth/pairing`, { headers: bearer(gm.body.token) })).status, 403);
  const publish = await fetch(`${baseUrl}/api/v1/campaigns/green_realm/session`, { method: "PUT", headers: { ...bearer(gm.body.token), "content-type": "application/json" }, body: JSON.stringify({ mode: "game", scene: { title: "Gate", description: "Open" } }) });
  assert.equal(publish.status, 200);
});

test("lets Admin view sessions and rotate the GM PIN", async () => {
  const admin = await pair({ role: "admin", pin: "111111", device_name: "Admin laptop" });
  const pairing = await fetch(`${baseUrl}/api/v1/auth/pairing`, { headers: bearer(admin.body.token) }).then((response) => response.json());
  assert.equal(pairing.data.gm_pin, "222222");
  const sessions = await fetch(`${baseUrl}/api/v1/auth/sessions`, { headers: bearer(admin.body.token) }).then((response) => response.json());
  assert.ok(sessions.data.some((session) => session.device_name === "GM tablet"));

  const rotated = await fetch(`${baseUrl}/api/v1/auth/gm-pin/rotate`, { method: "POST", headers: bearer(admin.body.token) });
  assert.equal(rotated.status, 200);
  const newPin = (await rotated.json()).data.gm_pin;
  assert.match(newPin, /^\d{6}$/);
  assert.equal(persistedGmPin, newPin);
  assert.equal((await fetch(`${baseUrl}/api/v1/auth/me`, { headers: bearer(gmToken) })).status, 401);
  assert.equal((await pair({ role: "gm", pin: "222222", campaign_id: "green_realm" })).response.status, 401);
  assert.equal((await pair({ role: "gm", pin: newPin, campaign_id: "green_realm" })).response.status, 201);
});

test("scopes Player access to one character and read-only table state", async () => {
  const player = await pair({ role: "player", campaign_id: "green_realm", character_id: "nyra" });
  assert.equal(player.response.status, 201);
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns/green_realm/characters/nyra`, { headers: bearer(player.body.token) })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns/green_realm/characters/orin`, { headers: bearer(player.body.token) })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns/green_realm/session`, { headers: bearer(player.body.token) })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/v1/campaigns/green_realm/session`, { method: "PUT", headers: { ...bearer(player.body.token), "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/v1/auth/session`, { method: "DELETE", headers: bearer(player.body.token) })).status, 204);
  assert.equal((await fetch(`${baseUrl}/api/v1/auth/me`, { headers: bearer(player.body.token) })).status, 401);
});
