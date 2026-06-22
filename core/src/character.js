const SAFE_ID = /^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeResource(resourceId, value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : { current: value };
  const current = finiteNumber(input.current);
  const maximum = Math.max(0, finiteNumber(input.maximum ?? input.max, current));
  return {
    resource_id: resourceId,
    label: String(input.label ?? resourceId.replaceAll("_", " ")).trim().slice(0, 40),
    current,
    maximum,
  };
}

export function validateCharacter(input, { requireId = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["character body must be an object"];
  const errors = [];
  if (requireId && (typeof input.character_id !== "string" || !SAFE_ID.test(input.character_id))) {
    errors.push("character_id must use lowercase letters, numbers, hyphens, or underscores");
  }
  if (typeof input.character_name !== "string" || input.character_name.trim() === "") errors.push("character_name is required");
  if (input.resources !== undefined && (!input.resources || typeof input.resources !== "object" || Array.isArray(input.resources))) errors.push("resources must be an object");
  if (input.conditions !== undefined && !Array.isArray(input.conditions)) errors.push("conditions must be an array");
  if (input.fields !== undefined && (!input.fields || typeof input.fields !== "object" || Array.isArray(input.fields))) errors.push("fields must be an object");
  return errors;
}

export function normalizeCharacter(campaignId, input, existing = null) {
  const now = new Date().toISOString();
  const resources = Object.fromEntries(Object.entries(input.resources ?? {}).slice(0, 12).map(([id, value]) => [id, normalizeResource(id, value)]));
  const fields = Object.fromEntries(Object.entries(input.fields ?? {}).slice(0, 20).map(([key, value]) => [key, typeof value === "number" || typeof value === "boolean" ? value : String(value ?? "").trim().slice(0, 120)]));
  return {
    character_id: existing?.character_id ?? input.character_id,
    campaign_id: campaignId,
    player_name: String(input.player_name ?? "").trim().slice(0, 80),
    character_name: String(input.character_name).trim().slice(0, 80),
    fields,
    resources,
    conditions: [...new Set((input.conditions ?? []).map((condition) => String(condition).trim()).filter(Boolean))].slice(0, 20),
    public_notes: String(input.public_notes ?? "").trim().slice(0, 2000),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}
