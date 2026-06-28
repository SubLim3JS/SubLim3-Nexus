import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sendJson } from "./http.js";
import { serveStatic } from "./static.js";
import { addCombatant, advanceTurn, emptySession, endBattle, normalizeSession, previousTurn, removeCombatant, reorderCombatants, resetRound, resetSession, updateCombatant } from "./session.js";
import { normalizeCharacter, validateCharacter } from "./character.js";
import { applyGameSystemDefaults, normalizeGameSystem, validateGameSystem } from "./game-system.js";
import { loadAudioPackCatalog } from "./audio-packs.js";

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

function resourceAdjustmentRouteFrom(pathname) {
  const match = pathname.match(/^\/api\/v1\/campaigns\/([^/]+)\/characters\/([^/]+)\/resources\/([^/]+)\/adjust$/);
  return match ? {
    campaignId: decodeURIComponent(match[1]),
    characterId: decodeURIComponent(match[2]),
    resourceId: decodeURIComponent(match[3]),
  } : null;
}

function systemRouteFrom(pathname) {
  const match = pathname.match(/^\/api\/v1\/systems(?:\/([^/]+))?$/);
  return match ? { systemId: match[1] ? decodeURIComponent(match[1]) : null } : null;
}

function streamAudio(request, response, opened, contentType) {
  const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  let start = 0;
  let end = opened.size - 1;
  if (range) {
    if (!range[1] && range[2]) {
      const suffixLength = Number(range[2]);
      start = Math.max(0, opened.size - suffixLength);
    } else {
      start = range[1] ? Number(range[1]) : 0;
      end = range[2] ? Number(range[2]) : end;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= opened.size) {
      response.writeHead(416, { "content-range": `bytes */${opened.size}` });
      response.end();
      return;
    }
    end = Math.min(end, opened.size - 1);
  }
  response.writeHead(range ? 206 : 200, {
    "content-type": contentType,
    "content-length": end - start + 1,
    "accept-ranges": "bytes",
    ...(range ? { "content-range": `bytes ${start}-${end}/${opened.size}` } : {}),
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  opened.stream({ start, end }).on("error", () => response.destroy()).pipe(response);
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
  systemStore = null,
  expansionPacks = [],
  access,
  liveEvents,
  audio,
  audioPackSourceDirectory = null,
  audioPackRepoUrl = process.env.NEXUS_EXPANSIONS_REPO ?? "https://github.com/SubLim3JS/SubLim3-Nexus-Expansions.git",
  audioPackRef = process.env.NEXUS_EXPANSIONS_REF ?? "main",
  rfid,
  connectivity,
  systemControl,
  playerSettings,
  settingsPin = process.env.NEXUS_SETTINGS_PIN ?? "",
  getSystemInfo = async () => ({}),
  publicDirectory = defaultPublicDirectory,
  version = "1.6.3",
  startedAt = new Date(),
}) {
  const settingsGuard = { failures: 0, blockedUntil: 0 };
  const playSystemTone = async (result = "success") => {
    const value = result === "failure" ? "failure" : "success";
    if (audio) {
      try {
        await audio.triggerEffect(`system-update-${value}`);
        return;
      } catch (error) {
        if (typeof systemControl?.tone !== "function") throw error;
      }
    }
    if (typeof systemControl?.tone === "function") {
      await systemControl.tone(value);
    }
  };
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

      if (systemControl && request.method === "POST" && url.pathname.startsWith(`${API_PREFIX}/system/`)) {
        if (access) await access.authorize(request, { roles: ["admin"] }); else requireSettingsAccess(request, settingsPin, settingsGuard);
        if (url.pathname === `${API_PREFIX}/system/shutdown`) {
          await systemControl.shutdown();
          return sendJson(response, 202, { success: true, message: "Shutdown requested" });
        }
        if (url.pathname === `${API_PREFIX}/system/reboot`) {
          await systemControl.reboot();
          return sendJson(response, 202, { success: true, message: "Reboot requested" });
        }
        if (url.pathname === `${API_PREFIX}/system/update`) {
          try {
            const output = await systemControl.update();
            await playSystemTone("success");
            return sendJson(response, 202, { success: true, message: "Update installed; Nexus Core is restarting", output });
          } catch (error) {
            await playSystemTone("failure");
            throw error;
          }
        }
        if (url.pathname === `${API_PREFIX}/system/tone`) {
          const input = await readJson(request);
          await playSystemTone(input?.result === "failure" ? "failure" : "success");
          return sendJson(response, 200, { success: true });
        }
      }

      if (playerSettings && url.pathname === `${API_PREFIX}/settings/player`) {
        if (access) await access.authorize(request, { roles: ["admin"] }); else requireSettingsAccess(request, settingsPin, settingsGuard);
        if (request.method === "GET") return sendJson(response, 200, { data: await playerSettings.get() });
        if (request.method === "PUT") {
          const settings = await playerSettings.update(await readJson(request));
          await audio?.applyPreferences(settings);
          return sendJson(response, 200, { data: settings });
        }
        return sendJson(response, 405, { error: "method_not_allowed" });
      }

      if (rfid && request.method === "GET" && url.pathname === `${API_PREFIX}/rfid/cards`) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        return sendJson(response, 200, { data: await rfid.cards() });
      }

      if (rfid && request.method === "POST" && url.pathname === `${API_PREFIX}/rfid/cards`) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        return sendJson(response, 201, { data: await rfid.saveCard(await readJson(request)) });
      }

      const rfidCard = rfid && request.method === "DELETE" ? url.pathname.match(/^\/api\/v1\/rfid\/cards\/([^/]+)$/) : null;
      if (rfidCard) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        return (await rfid.deleteCard(decodeURIComponent(rfidCard[1])))
          ? sendJson(response, 204, null)
          : sendJson(response, 404, { error: "rfid_card_not_found" });
      }

      if (rfid && request.method === "GET" && url.pathname === `${API_PREFIX}/rfid/last-scan`) {
        return sendJson(response, 200, { data: await rfid.lastScan() });
      }

      if (rfid && request.method === "POST" && url.pathname === `${API_PREFIX}/rfid/scan`) {
        return sendJson(response, 200, { data: await rfid.scan(await readJson(request)) });
      }

      if (audio && request.method === "GET" && url.pathname === `${API_PREFIX}/audio/library`) {
        const kind = url.searchParams.get("kind");
        if (kind && !["ambience", "effect"].includes(kind)) return sendJson(response, 422, { error: "validation_failed", details: ["kind must be ambience or effect"] });
        return sendJson(response, 200, { data: await audio.library(kind) });
      }

      if (audio && request.method === "GET" && url.pathname === `${API_PREFIX}/audio/status`) {
        return sendJson(response, 200, { data: await audio.status() });
      }

      const audioContent = audio?.files && request.method === "GET" ? url.pathname.match(/^\/api\/v1\/audio\/files\/([^/]+)\/content$/) : null;
      if (audioContent) {
        const opened = await audio.files.open(decodeURIComponent(audioContent[1]));
        streamAudio(request, response, opened, opened.item.source.content_type);
        return;
      }

      const audioCover = audio?.files && request.method === "GET" ? url.pathname.match(/^\/api\/v1\/audio\/files\/([^/]+)\/cover$/) : null;
      if (audioCover) {
        const opened = await audio.files.openCover(decodeURIComponent(audioCover[1]));
        streamAudio(request, response, opened, opened.contentType);
        return;
      }

      const usbContent = audio?.files && request.method === "GET" ? url.pathname.match(/^\/api\/v1\/audio\/usb\/([^/]+)\/content$/) : null;
      if (usbContent) {
        const status = await audio.status();
        if (status.item_id !== decodeURIComponent(usbContent[1]) || status.item?.source?.type !== "usb") return sendJson(response, 404, { error: "usb_playback_not_found" });
        const opened = await audio.files.openUsb(status.item.source.source_path);
        streamAudio(request, response, opened, opened.contentType);
        return;
      }

      if (audio?.files && request.method === "GET" && url.pathname === `${API_PREFIX}/audio/folders`) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        return sendJson(response, 200, { data: await audio.files.folders() });
      }

      if (audio?.files && request.method === "GET" && url.pathname === `${API_PREFIX}/audio/usb`) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        return sendJson(response, 200, { data: await audio.files.usbFiles() });
      }

      if (audio?.files && request.method === "POST" && url.pathname === `${API_PREFIX}/audio/files/upload`) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        const filename = url.searchParams.get("filename");
        if (!filename) return sendJson(response, 422, { error: "validation_failed", details: ["filename is required"] });
        const item = await audio.files.saveUpload({
          stream: request,
          filename,
          folderPath: url.searchParams.get("folder") ?? "",
          kind: url.searchParams.get("kind") ?? "ambience",
          contentType: request.headers["content-type"],
        });
        return sendJson(response, 201, { data: item });
      }

      if (audio?.files && request.method === "POST" && url.pathname === `${API_PREFIX}/audio/folders`) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        const input = await readJson(request);
        return sendJson(response, 201, { data: await audio.files.createFolder(input?.parent_path, input?.name) });
      }

      if (audio?.files && request.method === "POST" && url.pathname === `${API_PREFIX}/audio/import`) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        const input = await readJson(request);
        return sendJson(response, 201, { data: await audio.files.importUsb({ sourcePath: input?.source_path, folderPath: input?.folder_path, kind: input?.kind }) });
      }

      if (audio?.files && request.method === "POST" && url.pathname === `${API_PREFIX}/audio/usb/play`) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        const input = await readJson(request);
        return sendJson(response, 200, { data: await audio.playUsb(input?.source_path) });
      }

      if (audio && request.method === "POST" && url.pathname === `${API_PREFIX}/audio/radio/play`) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        const input = await readJson(request);
        return sendJson(response, 200, { data: await audio.playRadio({ name: input?.name, url: input?.url }) });
      }

      const audioFile = audio?.files && request.method === "PUT" ? url.pathname.match(/^\/api\/v1\/audio\/files\/([^/]+)$/) : null;
      if (audioFile) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        const input = await readJson(request);
        return sendJson(response, 200, { data: await audio.files.move(decodeURIComponent(audioFile[1]), input?.folder_path) });
      }

      const deleteAudioFile = audio?.files && request.method === "DELETE" ? url.pathname.match(/^\/api\/v1\/audio\/files\/([^/]+)$/) : null;
      if (deleteAudioFile) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        return sendJson(response, 200, { data: await audio.files.delete(decodeURIComponent(deleteAudioFile[1])) });
      }

      if (audio && request.method === "POST" && url.pathname.startsWith(`${API_PREFIX}/audio/`)) {
        if (access) await access.authorize(request, { roles: ["admin", "gm"] });
        const input = await readJson(request);
        let status;
        if (url.pathname === `${API_PREFIX}/audio/play` || url.pathname === `${API_PREFIX}/audio/ambiance`) status = await audio.play(input?.item_id);
        else if (url.pathname === `${API_PREFIX}/audio/pause`) status = await audio.pause();
        else if (url.pathname === `${API_PREFIX}/audio/stop`) status = await audio.stop();
        else if (url.pathname === `${API_PREFIX}/audio/volume`) status = await audio.setVolume(input?.volume);
        else {
          const effectMatch = url.pathname.match(/^\/api\/v1\/audio\/effects\/([^/]+)\/trigger$/);
          if (!effectMatch) return sendJson(response, 404, { error: "not_found" });
          status = await audio.triggerEffect(decodeURIComponent(effectMatch[1]));
        }
        return sendJson(response, 200, { data: status });
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

      if (access && request.method === "POST" && url.pathname === `${API_PREFIX}/auth/sessions/revoke-others`) {
        return sendJson(response, 200, { data: { revoked_count: await access.revokeOthers(request) } });
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

      if (connectivity && request.method === "POST" && url.pathname === `${API_PREFIX}/connectivity/tools/ping`) {
        if (access) await access.authorize(request, { roles: ["admin"] }); else requireSettingsAccess(request, settingsPin, settingsGuard);
        const input = await readJson(request);
        return sendJson(response, 200, { data: await connectivity.ping(input.target) });
      }

      if (systemStore && request.method === "GET" && url.pathname === `${API_PREFIX}/packs`) {
        if (access) await access.authorize(request, { roles: ["admin"] });
        const data = await Promise.all(expansionPacks.map(async ({ system, ...pack }) => {
          const installed = Boolean(await systemStore.get(pack.system_id));
          return {
            ...pack,
            installed,
            enabled: installed,
            field_count: system.character_sheet.fields.length,
            resource_count: system.character_sheet.resources.length,
            page_count: system.character_sheet.pages.length,
          };
        }));
        return sendJson(response, 200, { data });
      }

      const packRoute = systemStore ? url.pathname.match(/^\/api\/v1\/packs\/([^/]+)(\/install)?$/) : null;
      if (packRoute) {
        if (access) await access.authorize(request, { roles: ["admin"] });
        const packId = decodeURIComponent(packRoute[1]);
        const pack = expansionPacks.find((item) => item.pack_id === packId);
        if (!pack) return sendJson(response, 404, { error: "pack_not_found" });
        const existing = await systemStore.get(pack.system_id);
        if (request.method === "POST" && packRoute[2] === "/install") {
          if (existing && existing.pack?.pack_id !== pack.pack_id) return sendJson(response, 409, { error: "system_id_conflict" });
          if (!existing || existing.version !== pack.system.version) await systemStore.put(pack.system_id, pack.system);
          return sendJson(response, 200, { success: true, data: { pack_id: pack.pack_id, system_id: pack.system_id, installed: true } });
        }
        if (request.method === "DELETE" && !packRoute[2]) {
          if (pack.preinstalled) return sendJson(response, 409, { error: "core_pack" });
          if (!existing) return sendJson(response, 204, null);
          if (existing.pack?.pack_id !== pack.pack_id) return sendJson(response, 409, { error: "system_id_conflict" });
          if ((await campaignStore.list()).some((campaign) => campaign.system_id === pack.system_id)) return sendJson(response, 409, { error: "pack_in_use" });
          await systemStore.delete(pack.system_id);
          return sendJson(response, 204, null);
        }
        return sendJson(response, 405, { error: "method_not_allowed" });
      }

      if (audio?.files && request.method === "GET" && url.pathname === `${API_PREFIX}/audio-packs`) {
        if (access) await access.authorize(request, { roles: ["admin"] });
        const catalog = await loadAudioPackCatalog(audioPackSourceDirectory);
        const installedOnly = new Map((await audio.files.importedExpansionPacks()).map((pack) => [pack.pack_id, pack]));
        const data = await Promise.all(catalog.map(async (pack) => {
          const installedItems = await audio.files.importedExpansionItems(pack.pack_id);
          installedOnly.delete(pack.pack_id);
          return {
            ...pack,
            installed: installedItems.length > 0,
            enabled: installedItems.length > 0,
            installed_file_count: installedItems.length,
          };
        }));
        return sendJson(response, 200, { data: [...data, ...installedOnly.values()] });
      }

      const audioPackRoute = audio?.files ? url.pathname.match(/^\/api\/v1\/audio-packs\/([^/]+)(\/install)?$/) : null;
      if (audioPackRoute) {
        if (access) await access.authorize(request, { roles: ["admin"] });
        const packId = decodeURIComponent(audioPackRoute[1]);
        if (request.method === "DELETE" && !audioPackRoute[2]) {
          const removedCount = await audio.files.removeExpansionPack(packId);
          return sendJson(response, 200, { success: true, data: { pack_id: packId, installed: false, removed_count: removedCount } });
        }
        const catalog = await loadAudioPackCatalog(audioPackSourceDirectory);
        const pack = catalog.find((item) => item.pack_id === packId);
        if (!pack) return sendJson(response, 404, { error: "audio_pack_not_found" });
        if (request.method === "POST" && audioPackRoute[2] === "/install") {
          const imported = await audio.files.importExpansionPack({ packId, sourceDirectory: audioPackSourceDirectory, repoUrl: audioPackRepoUrl, ref: audioPackRef });
          return sendJson(response, 200, { success: true, data: { pack_id: packId, installed: true, imported_count: imported.length } });
        }
        return sendJson(response, 405, { error: "method_not_allowed" });
      }

      const systemRoute = systemStore ? systemRouteFrom(url.pathname) : null;
      if (systemRoute) {
        if (!systemRoute.systemId && request.method === "GET") {
          if (access) await access.authorize(request, { roles: ["admin", "gm", "player"] });
          return sendJson(response, 200, { data: await systemStore.list() });
        }
        if (!systemRoute.systemId && request.method === "POST") {
          if (access) await access.authorize(request, { roles: ["admin"] });
          const input = await readJson(request);
          const errors = validateGameSystem(input);
          if (errors.length) return sendJson(response, 422, { error: "validation_failed", details: errors });
          if (await systemStore.get(input.system_id)) return sendJson(response, 409, { error: "system_exists" });
          const system = normalizeGameSystem(input);
          await systemStore.put(system.system_id, system);
          return sendJson(response, 201, { data: system });
        }
        if (systemRoute.systemId) {
          const existing = await systemStore.get(systemRoute.systemId);
          if (!existing) return sendJson(response, 404, { error: "system_not_found" });
          if (request.method === "GET") {
            if (access) await access.authorize(request, { roles: ["admin", "gm", "player"] });
            return sendJson(response, 200, { data: existing });
          }
          if (request.method === "PUT") {
            if (access) await access.authorize(request, { roles: ["admin"] });
            const input = await readJson(request);
            const errors = validateGameSystem(input, { requireId: false });
            if (errors.length) return sendJson(response, 422, { error: "validation_failed", details: errors });
            const system = normalizeGameSystem(input, existing);
            await systemStore.put(existing.system_id, system);
            return sendJson(response, 200, { data: system });
          }
          if (request.method === "DELETE") {
            if (access) await access.authorize(request, { roles: ["admin"] });
            if (existing.built_in) return sendJson(response, 409, { error: "built_in_system" });
            if ((await campaignStore.list()).some((campaign) => campaign.system_id === existing.system_id)) return sendJson(response, 409, { error: "system_in_use" });
            await systemStore.delete(existing.system_id);
            return sendJson(response, 204, null);
          }
        }
        return sendJson(response, 405, { error: "method_not_allowed" });
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
          if (systemStore && !await systemStore.get(input.system_id)) return sendJson(response, 422, { error: "validation_failed", details: ["system_id does not match an installed game system"] });
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

      const resourceAdjustmentRoute = characterStore && request.method === "POST" ? resourceAdjustmentRouteFrom(url.pathname) : null;
      if (resourceAdjustmentRoute) {
        const { campaignId, characterId, resourceId } = resourceAdjustmentRoute;
        if (access) await access.authorize(request, { roles: ["admin", "gm", "player"], campaignId, characterId });
        if (!await campaignStore.get(campaignId)) return sendJson(response, 404, { error: "campaign_not_found" });
        const character = await characterStore.get(characterId);
        if (!character || character.campaign_id !== campaignId) return sendJson(response, 404, { error: "character_not_found" });
        if (resourceId !== "health") return sendJson(response, 403, { error: "resource_not_player_editable" });
        const resource = character.resources?.[resourceId];
        if (!resource) return sendJson(response, 404, { error: "resource_not_found" });
        const input = await readJson(request);
        const delta = Number(input?.delta);
        if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) {
          return sendJson(response, 422, { error: "validation_failed", details: ["delta must be a non-zero integer between -100 and 100"] });
        }

        let session = sessionStore ? await sessionStore.get(campaignId) : null;
        const liveCombatant = session?.mode === "battle"
          ? session.battle.combatants.find((item) => item.character_id === characterId && item.health)
          : null;
        const maximum = Math.max(0, Number(liveCombatant?.health.maximum ?? resource.maximum) || 0);
        const current = Math.max(0, Math.min(maximum, Number(liveCombatant?.health.current ?? resource.current) || 0));
        const nextCurrent = Math.max(0, Math.min(maximum, current + delta));
        let conditions = character.conditions;
        let trackers = character.trackers;
        let sessionChanged = false;

        if (liveCombatant && sessionStore) {
          session = updateCombatant(session, liveCombatant.combatant_id, { health_change: nextCurrent - current });
          const updatedCombatant = session.battle.combatants.find((item) => item.combatant_id === liveCombatant.combatant_id);
          conditions = updatedCombatant.conditions;
          trackers = updatedCombatant.trackers;
          sessionChanged = true;
        } else if (nextCurrent > 0) {
          trackers = Object.fromEntries(Object.entries(trackers ?? {}).map(([id, tracker]) => [
            id,
            tracker.reset_on_resource_positive && tracker.visible_when?.resource_id === resourceId
              ? { ...tracker, successes: 0, failures: 0, status: "active" }
              : tracker,
          ]));
        }

        const updatedCharacter = {
          ...character,
          resources: { ...character.resources, [resourceId]: { ...resource, current: nextCurrent, maximum } },
          conditions,
          trackers,
          updated_at: new Date().toISOString(),
        };
        await characterStore.put(characterId, updatedCharacter);
        if (sessionChanged) {
          await sessionStore.put(campaignId, session);
          liveEvents?.publish(campaignId, session);
        }
        return sendJson(response, 200, { data: updatedCharacter });
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
          const system = systemStore ? await systemStore.get(campaign.system_id) : null;
          const character = normalizeCharacter(characterRoute.campaignId, applyGameSystemDefaults(input, system), null, system);
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
            const system = systemStore ? await systemStore.get(campaign.system_id) : null;
            const character = normalizeCharacter(characterRoute.campaignId, applyGameSystemDefaults({ ...input, trackers: input.trackers ?? existing.trackers }, system), existing, system);
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
            await characterStore.put(character.character_id, { ...character, resources, conditions: combatant.conditions, trackers: combatant.trackers, updated_at: new Date().toISOString() });
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
          if (systemStore && !await systemStore.get(input.system_id)) return sendJson(response, 422, { error: "validation_failed", details: ["system_id does not match an installed game system"] });
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
