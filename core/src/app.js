import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sendJson } from "./http.js";
import { serveStatic } from "./static.js";
import { addCombatant, advanceTurn, emptySession, endBattle, normalizeSession, previousTurn, removeCombatant, reorderCombatants, resetRound, resetSession, updateCombatant } from "./session.js";
import { normalizeCharacter, validateCharacter } from "./character.js";

const API_PREFIX = "/api/v1";
const defaultPublicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

function campaignIdFrom(pathname) {
  const match = pathname.match(/^\/api\/v1\/campaigns\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function sessionRouteFrom(pathname) {
  const match = pathname.match(/^\/api\/v1\/campaigns\/([^/]+)\/(session|session\/reset|battle\/next|battle\/previous|battle\/round\/reset|battle\/reorder|battle\/end|events)$/);
  return match ? { campaignId: decodeURIComponent(match[1]), action: match[2] } : null;
}

function validateCampaign(input, { requireId = true } = {}) {
  const errors = [];
  if (requireId && typeof input.campaign_id !== "string") errors.push("campaign_id is required");
  if (typeof input.name !== "string" || input.name.trim() === "") errors.push("name is required");
  if (typeof input.system_id !== "string" || input.system_id.trim() === "") errors.push("system_id is required");
  return errors;
}

function combatantRouteFrom(pathname) {
  const match = pathname.match(/^\/api\/v1\/campaigns\/([^/]+)\/battle\/combatants(?:\/([^/]+))?$/);
  return match ? { campaignId: decodeURIComponent(match[1]), combatantId: match[2] ? decodeURIComponent(match[2]) : null } : null;
}

function characterRouteFrom(pathname) {
  const match = pathname.match(/^\/api\/v1\/campaigns\/([^/]+)\/characters(?:\/([^/]+))?$/);
  return match ? { campaignId: decodeURIComponent(match[1]), characterId: match[2] ? decodeURIComponent(match[2]) : null } : null;
}

function requireSettingsAccess(request, settingsPin, guard) {
  if (!settingsPin) throw Object.assign(new Error("Settings PIN is not configured"), { statusCode: 503 });
  if (guard.blockedUntil > Date.now()) throw Object.assign(new Error("Too many failed PIN attempts; try again shortly"), { statusCode: 429 });
  const supplied = request.headers["x-nexus-settings-pin"];
  const expectedBuffer = Buffer.from(settingsPin);
  const suppliedBuffer = Buffer.from(typeof supplied === "string" ? supplied : "");
  if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    guard.failures += 1;
    if (guard.failures >= 5) { guard.blockedUntil = Date.now() + 60_000; guard.failures = 0; }
    throw Object.assign(new Error("Valid Settings PIN required"), { statusCode: 401 });
  }
  guard.failures = 0;
  guard.blockedUntil = 0;
}

export function createApp({
  campaignStore,
  sessionStore,
  characterStore,
  access,
  liveEvents,
  connectivity,
  settingsPin = process.env.NEXUS_SETTINGS_PIN ?? "",
  getSystemInfo = async () => ({}),
  publicDirectory = defaultPublicDirectory,
  version = "1.1.0",
  startedAt = new Date(),
}) {
  const settingsGuard = { failures: 0, blockedUntil: 0 };
  return async function app(request, response) {
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);

    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === `${API_PREFIX}/system/status`) {
        return sendJson(response, 200, {
          status: "ok",
          service: "nexus-core",
          version,
          uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        });
      }

      if (request.method === "GET" && url.pathname === `${API_PREFIX}/system/info`) {
        return sendJson(response, 200, {
          ...await getSystemInfo(),
          service: "nexus-core",
          version,
          uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        });
      }

      if (access && request.method === "POST" && url.pathname === `${API_PREFIX}/auth/pair`) {
        const input = await readJson(request);
        if (!input || typeof input !== "object") return sendJson(response, 422, { error: "validation_failed", details: ["pairing body must be an object"] });
        const role = String(input.role ?? "");
        const campaignId = input.campaign_id ? String(input.campaign_id) : null;
        const characterId = input.character_id ? String(input.character_id) : null;
        if (role === "gm" || role === "player") {
          if (!campaignId || !await campaignStore.get(campaignId)) return sendJson(response, 404, { error: "campaign_not_found" });
        }
        if (role === "player") {
          const character = characterId ? await characterStore.get(characterId) : null;
          if (!character || character.campaign_id !== campaignId) return sendJson(response, 404, { error: "character_not_found" });
        }
        const paired = await access.pair({ role, pin: input.pin, campaignId, characterId, deviceName: input.device_name });
        return sendJson(response, 201, { token: paired.token, data: paired.session });
      }

      if (access && request.method === "GET" && url.pathname === `${API_PREFIX}/auth/me`) {
        return sendJson(response, 200, { data: await access.authenticate(request) });
      }

      if (access && request.method === "DELETE" && url.pathname === `${API_PREFIX}/auth/session`) {
        await access.revoke(request);
        return sendJson(response, 204, null);
      }

      if (access && request.method === "GET" && url.pathname === `${API_PREFIX}/auth/sessions`) {
        await access.authorize(request, { roles: ["admin"] });
        return sendJson(response, 200, { data: await access.list() });
      }

      if (access && request.method === "GET" && url.pathname === `${API_PREFIX}/auth/pairing`) {
        await access.authorize(request, { roles: ["admin"] });
        return sendJson(response, 200, { data: access.pairingInfo() });
      }

      if (access && request.method === "POST" && url.pathname === `${API_PREFIX}/auth/gm-pin/rotate`) {
        await access.authorize(request, { roles: ["admin"] });
        return sendJson(response, 200, { data: { gm_pin: await access.rotateGmPin() } });
      }

      const revokeSession = access && request.method === "DELETE" ? url.pathname.match(/^\/api\/v1\/auth\/sessions\/([a-f0-9]{64})$/) : null;
      if (revokeSession) {
        await access.authorize(request, { roles: ["admin"] });
        return (await access.revokeById(revokeSession[1])) ? sendJson(response, 204, null) : sendJson(response, 404, { error: "session_not_found" });
      }

      if (request.method === "GET" && url.pathname === `${API_PREFIX}/discovery/campaigns`) {
        const campaigns = await campaignStore.list();
        return sendJson(response, 200, { data: campaigns.map(({ campaign_id, name, system_id }) => ({ campaign_id, name, system_id })) });
      }

      const discoveryCharacters = request.method === "GET" ? url.pathname.match(/^\/api\/v1\/discovery\/campaigns\/([^/]+)\/characters$/) : null;
      if (discoveryCharacters) {
        const campaignId = decodeURIComponent(discoveryCharacters[1]);
        if (!await campaignStore.get(campaignId)) return sendJson(response, 404, { error: "campaign_not_found" });
        const characters = (await characterStore.list()).filter((item) => item.campaign_id === campaignId);
        return sendJson(response, 200, { data: characters.map(({ character_id, character_name }) => ({ character_id, character_name })) });
      }

      if (connectivity && request.method === "GET" && url.pathname === `${API_PREFIX}/connectivity/status`) {
        if (access) await access.authorize(request, { roles: ["admin"] }); else requireSettingsAccess(request, settingsPin, settingsGuard);
        return sendJson(response, 200, { data: await connectivity.status() });
      }

      if (connectivity && request.method === "GET" && url.pathname === `${API_PREFIX}/connectivity/wifi/networks`) {
        if (access) await access.authorize(request, { roles: ["admin"] }); else requireSettingsAccess(request, settingsPin, settingsGuard);
        return sendJson(response, 200, { data: await connectivity.scanWifi() });
      }

      if (connectivity && request.method === "POST" && url.pathname === `${API_PREFIX}/connectivity/wifi/mode`) {
        if (access) await access.authorize(request, { roles: ["admin"] }); else requireSettingsAccess(request, settingsPin, settingsGuard);
        await connectivity.switchWifi(await readJson(request));
        return sendJson(response, 202, { success: true, message: "Connectivity change accepted" });
      }

      if (connectivity && request.method === "POST" && url.pathname === `${API_PREFIX}/connectivity/bluetooth/visibility`) {
        if (access) await access.authorize(request, { roles: ["admin"] }); else requireSettingsAccess(request, settingsPin, settingsGuard);
        const input = await readJson(request);
        if (typeof input.visible !== "boolean") return sendJson(response, 422, { error: "validation_failed", details: ["visible must be boolean"] });
        await connectivity.setBluetoothVisible(input.visible);
        return sendJson(response, 200, { success: true, visible: input.visible });
      }

      if (url.pathname === `${API_PREFIX}/campaigns`) {
        if (access) await access.authorize(request, { roles: ["admin"] });
        if (request.method === "GET") {
          return sendJson(response, 200, { data: await campaignStore.list() });
        }

        if (request.method === "POST") {
          const input = await readJson(request);
          const errors = validateCampaign(input);
          if (errors.length) return sendJson(response, 422, { error: "validation_failed", details: errors });
          if (await campaignStore.get(input.campaign_id)) {
            return sendJson(response, 409, { error: "campaign_exists" });
          }

          const now = new Date().toISOString();
          const campaign = {
            campaign_id: input.campaign_id,
            name: input.name.trim(),
            system_id: input.system_id.trim(),
            created_at: now,
            updated_at: now,
            active: Boolean(input.active),
          };
          await campaignStore.put(campaign.campaign_id, campaign);
          return sendJson(response, 201, { data: campaign });
        }

        return sendJson(response, 405, { error: "method_not_allowed" });
      }

      const characterRoute = characterStore ? characterRouteFrom(url.pathname) : null;
      if (characterRoute) {
        const campaign = await campaignStore.get(characterRoute.campaignId);
        if (!campaign) return sendJson(response, 404, { error: "campaign_not_found" });

        if (!characterRoute.characterId && request.method === "GET") {
          if (access) await access.authorize(request, { roles: ["admin", "gm"], campaignId: characterRoute.campaignId });
          const characters = (await characterStore.list()).filter((item) => item.campaign_id === characterRoute.campaignId);
          return sendJson(response, 200, { data: characters });
        }
        if (!characterRoute.characterId && request.method === "POST") {
          if (access) await access.authorize(request, { roles: ["admin", "gm"], campaignId: characterRoute.campaignId });
          const input = await readJson(request);
          const errors = validateCharacter(input);
          if (errors.length) return sendJson(response, 422, { error: "validation_failed", details: errors });
          if (await characterStore.get(input.character_id)) return sendJson(response, 409, { error: "character_exists" });
          const character = normalizeCharacter(characterRoute.campaignId, input);
          await characterStore.put(character.character_id, character);
          return sendJson(response, 201, { data: character });
        }

        if (characterRoute.characterId) {
          const existing = await characterStore.get(characterRoute.characterId);
          if (!existing || existing.campaign_id !== characterRoute.campaignId) return sendJson(response, 404, { error: "character_not_found" });
          if (request.method === "GET") {
            if (access) await access.authorize(request, { roles: ["admin", "gm", "player"], campaignId: characterRoute.campaignId, characterId: characterRoute.characterId });
            return sendJson(response, 200, { data: existing });
          }
          if (request.method === "PUT") {
            if (access) await access.authorize(request, { roles: ["admin", "gm"], campaignId: characterRoute.campaignId });
            const input = await readJson(request);
            const errors = validateCharacter(input, { requireId: false });
            if (errors.length) return sendJson(response, 422, { error: "validation_failed", details: errors });
            const character = normalizeCharacter(characterRoute.campaignId, input, existing);
            await characterStore.put(existing.character_id, character);
            return sendJson(response, 200, { data: character });
          }
          if (request.method === "DELETE") {
            if (access) await access.authorize(request, { roles: ["admin", "gm"], campaignId: characterRoute.campaignId });
            await characterStore.delete(existing.character_id);
            return sendJson(response, 204, null);
          }
        }
        return sendJson(response, 405, { error: "method_not_allowed" });
      }

      const sessionRoute = sessionStore ? sessionRouteFrom(url.pathname) : null;
      if (sessionRoute) {
        const campaign = await campaignStore.get(sessionRoute.campaignId);
        if (!campaign) return sendJson(response, 404, { error: "campaign_not_found" });

        if (sessionRoute.action === "events" && request.method === "GET") {
          if (access) await access.authorize(request, { roles: ["admin", "gm", "player"], campaignId: sessionRoute.campaignId });
          if (!liveEvents) return sendJson(response, 503, { error: "live_events_unavailable" });
          const session = await sessionStore.get(sessionRoute.campaignId) ?? emptySession(sessionRoute.campaignId);
          liveEvents.stream(sessionRoute.campaignId, request, response, session);
          return;
        }
        if (sessionRoute.action === "session" && request.method === "GET") {
          if (access) await access.authorize(request, { roles: ["admin", "gm", "player"], campaignId: sessionRoute.campaignId });
          return sendJson(response, 200, { data: await sessionStore.get(sessionRoute.campaignId) ?? emptySession(sessionRoute.campaignId) });
        }
        if (sessionRoute.action === "session" && request.method === "PUT") {
          if (access) await access.authorize(request, { roles: ["admin", "gm"], campaignId: sessionRoute.campaignId });
          const session = normalizeSession(sessionRoute.campaignId, await readJson(request));
          await sessionStore.put(sessionRoute.campaignId, session);
          liveEvents?.publish(sessionRoute.campaignId, session);
          return sendJson(response, 200, { data: session });
        }
        if (sessionRoute.action === "session/reset" && request.method === "POST") {
          if (access) await access.authorize(request, { roles: ["admin"] });
          const session = resetSession(sessionRoute.campaignId);
          await sessionStore.put(sessionRoute.campaignId, session);
          liveEvents?.publish(sessionRoute.campaignId, session);
          return sendJson(response, 200, { data: session });
        }
        if (sessionRoute.action === "battle/next" && request.method === "POST") {
          if (access) await access.authorize(request, { roles: ["admin", "gm"], campaignId: sessionRoute.campaignId });
          const session = advanceTurn(await sessionStore.get(sessionRoute.campaignId) ?? emptySession(sessionRoute.campaignId));
          await sessionStore.put(sessionRoute.campaignId, session);
          liveEvents?.publish(sessionRoute.campaignId, session);
          return sendJson(response, 200, { data: session });
        }
        if (sessionRoute.action === "battle/previous" && request.method === "POST") {
          if (access) await access.authorize(request, { roles: ["admin", "gm"], campaignId: sessionRoute.campaignId });
          const session = previousTurn(await sessionStore.get(sessionRoute.campaignId) ?? emptySession(sessionRoute.campaignId));
          await sessionStore.put(sessionRoute.campaignId, session);
          liveEvents?.publish(sessionRoute.campaignId, session);
          return sendJson(response, 200, { data: session });
        }
        if (sessionRoute.action === "battle/round/reset" && request.method === "POST") {
          if (access) await access.authorize(request, { roles: ["admin", "gm"], campaignId: sessionRoute.campaignId });
          const session = resetRound(await sessionStore.get(sessionRoute.campaignId) ?? emptySession(sessionRoute.campaignId));
          await sessionStore.put(sessionRoute.campaignId, session);
          liveEvents?.publish(sessionRoute.campaignId, session);
          return sendJson(response, 200, { data: session });
        }
        if (sessionRoute.action === "battle/reorder" && request.method === "POST") {
          if (access) await access.authorize(request, { roles: ["admin", "gm"], campaignId: sessionRoute.campaignId });
          const input = await readJson(request);
          const session = reorderCombatants(await sessionStore.get(sessionRoute.campaignId) ?? emptySession(sessionRoute.campaignId), input?.combatant_ids);
          await sessionStore.put(sessionRoute.campaignId, session);
          liveEvents?.publish(sessionRoute.campaignId, session);
          return sendJson(response, 200, { data: session });
        }
        if (sessionRoute.action === "battle/end" && request.method === "POST") {
          if (access) await access.authorize(request, { roles: ["admin", "gm"], campaignId: sessionRoute.campaignId });
          const session = endBattle(await sessionStore.get(sessionRoute.campaignId) ?? emptySession(sessionRoute.campaignId));
          await sessionStore.put(sessionRoute.campaignId, session);
          liveEvents?.publish(sessionRoute.campaignId, session);
          return sendJson(response, 200, { data: session });
        }
        return sendJson(response, 405, { error: "method_not_allowed" });
      }

      const combatantRoute = sessionStore ? combatantRouteFrom(url.pathname) : null;
      if (combatantRoute) {
        if (!await campaignStore.get(combatantRoute.campaignId)) return sendJson(response, 404, { error: "campaign_not_found" });
        if (access) await access.authorize(request, { roles: ["admin", "gm"], campaignId: combatantRoute.campaignId });
        const existingSession = await sessionStore.get(combatantRoute.campaignId) ?? emptySession(combatantRoute.campaignId);
        let session;
        if (!combatantRoute.combatantId && request.method === "POST") session = addCombatant(existingSession, await readJson(request));
        else if (combatantRoute.combatantId && request.method === "DELETE") session = removeCombatant(existingSession, combatantRoute.combatantId);
        else if (combatantRoute.combatantId && request.method === "PATCH") session = updateCombatant(existingSession, combatantRoute.combatantId, await readJson(request));
        else return sendJson(response, 405, { error: "method_not_allowed" });
        const combatant = session.battle.combatants.find((item) => item.combatant_id === combatantRoute.combatantId);
        if (request.method === "PATCH" && combatant?.character_id && characterStore) {
          const character = await characterStore.get(combatant.character_id);
          if (character?.campaign_id === combatantRoute.campaignId) {
            const resources = { ...character.resources };
            if (combatant.health) resources.health = { ...(resources.health ?? {}), label: resources.health?.label ?? "Health", current: combatant.health.current, maximum: combatant.health.maximum };
            await characterStore.put(character.character_id, { ...character, resources, conditions: combatant.conditions, updated_at: new Date().toISOString() });
          }
        }
        await sessionStore.put(combatantRoute.campaignId, session);
        liveEvents?.publish(combatantRoute.campaignId, session);
        return sendJson(response, 200, { data: session });
      }

      const campaignId = campaignIdFrom(url.pathname);
      if (campaignId) {
        if (request.method === "GET") {
          if (access) await access.authorize(request, { roles: ["admin", "gm", "player"], campaignId });
          const campaign = await campaignStore.get(campaignId);
          return campaign
            ? sendJson(response, 200, { data: campaign })
            : sendJson(response, 404, { error: "campaign_not_found" });
        }

        if (request.method === "PUT") {
          if (access) await access.authorize(request, { roles: ["admin"] });
          const existing = await campaignStore.get(campaignId);
          if (!existing) return sendJson(response, 404, { error: "campaign_not_found" });
          const input = await readJson(request);
          const errors = validateCampaign(input, { requireId: false });
          if (errors.length) return sendJson(response, 422, { error: "validation_failed", details: errors });
          const campaign = {
            ...existing,
            name: input.name.trim(),
            system_id: input.system_id.trim(),
            active: input.active === undefined ? existing.active : Boolean(input.active),
            updated_at: new Date().toISOString(),
          };
          await campaignStore.put(campaignId, campaign);
          return sendJson(response, 200, { data: campaign });
        }

        if (request.method === "DELETE") {
          if (access) await access.authorize(request, { roles: ["admin"] });
          return (await campaignStore.delete(campaignId))
            ? sendJson(response, 204, null)
            : sendJson(response, 404, { error: "campaign_not_found" });
        }

        return sendJson(response, 405, { error: "method_not_allowed" });
      }

      if (request.method === "GET" && await serveStatic(url.pathname, response, publicDirectory)) return;
      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (!error.statusCode || error.statusCode >= 500) console.error(`[${requestId}]`, error);
      return sendJson(response, error.statusCode ?? 500, {
        error: error.statusCode ? "bad_request" : "internal_server_error",
        message: error.statusCode ? error.message : undefined,
      });
    }
  };
}
