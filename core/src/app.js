import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, sendJson } from "./http.js";
import { serveStatic } from "./static.js";

const API_PREFIX = "/api/v1";
const defaultPublicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

function campaignIdFrom(pathname) {
  const match = pathname.match(/^\/api\/v1\/campaigns\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function validateCampaign(input, { requireId = true } = {}) {
  const errors = [];
  if (requireId && typeof input.campaign_id !== "string") errors.push("campaign_id is required");
  if (typeof input.name !== "string" || input.name.trim() === "") errors.push("name is required");
  if (typeof input.system_id !== "string" || input.system_id.trim() === "") errors.push("system_id is required");
  return errors;
}

export function createApp({
  campaignStore,
  getSystemInfo = async () => ({}),
  publicDirectory = defaultPublicDirectory,
  version = "0.2.0",
  startedAt = new Date(),
}) {
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

      if (url.pathname === `${API_PREFIX}/campaigns`) {
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

      const campaignId = campaignIdFrom(url.pathname);
      if (campaignId) {
        if (request.method === "GET") {
          const campaign = await campaignStore.get(campaignId);
          return campaign
            ? sendJson(response, 200, { data: campaign })
            : sendJson(response, 404, { error: "campaign_not_found" });
        }

        if (request.method === "PUT") {
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
          return (await campaignStore.delete(campaignId))
            ? sendJson(response, 204, null)
            : sendJson(response, 404, { error: "campaign_not_found" });
        }

        return sendJson(response, 405, { error: "method_not_allowed" });
      }

      if (request.method === "GET" && await serveStatic(url.pathname, response, publicDirectory)) return;
      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      console.error(`[${requestId}]`, error);
      return sendJson(response, error.statusCode ?? 500, {
        error: error.statusCode ? "bad_request" : "internal_server_error",
        message: error.statusCode ? error.message : undefined,
      });
    }
  };
}
