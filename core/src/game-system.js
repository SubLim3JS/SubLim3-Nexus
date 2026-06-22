const SAFE_ID = /^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/;
const FIELD_TYPES = new Set(["text", "number", "boolean"]);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw Object.assign(new Error(`${label} must use lowercase letters, numbers, hyphens, or underscores`), { statusCode: 422 });
  return value;
}

function uniqueDefinitions(items, idKey, label, normalize) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).map((item) => {
    const normalized = normalize(item);
    if (seen.has(normalized[idKey])) throw Object.assign(new Error(`${label} IDs must be unique`), { statusCode: 422 });
    seen.add(normalized[idKey]);
    return normalized;
  });
}

export function validateGameSystem(input, { requireId = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["game system body must be an object"];
  const errors = [];
  if (requireId && (typeof input.system_id !== "string" || !SAFE_ID.test(input.system_id))) errors.push("system_id must use lowercase letters, numbers, hyphens, or underscores");
  if (typeof input.name !== "string" || !input.name.trim()) errors.push("name is required");
  if (input.character_sheet !== undefined && (!input.character_sheet || typeof input.character_sheet !== "object" || Array.isArray(input.character_sheet))) errors.push("character_sheet must be an object");
  return errors;
}

export function normalizeGameSystem(input, existing = null, { builtIn = false } = {}) {
  const now = new Date().toISOString();
  const sheet = input.character_sheet ?? {};
  const fields = uniqueDefinitions(sheet.fields, "field_id", "Field", (value) => {
    const field = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const type = FIELD_TYPES.has(field.type) ? field.type : "text";
    let defaultValue = field.default_value;
    if (type === "number") defaultValue = finiteNumber(defaultValue);
    else if (type === "boolean") defaultValue = Boolean(defaultValue);
    else defaultValue = String(defaultValue ?? "").slice(0, 120);
    return {
      field_id: cleanId(field.field_id, "field_id"),
      label: String(field.label ?? field.field_id).trim().slice(0, 40),
      type,
      section: String(field.section ?? "Identity").trim().slice(0, 40),
      default_value: defaultValue,
      player_visible: field.player_visible !== false,
    };
  }).slice(0, 50);
  const resources = uniqueDefinitions(sheet.resources, "resource_id", "Resource", (value) => {
    const resource = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const current = finiteNumber(resource.default_current);
    const maximum = Math.max(0, finiteNumber(resource.default_maximum, current));
    return {
      resource_id: cleanId(resource.resource_id, "resource_id"),
      label: String(resource.label ?? resource.resource_id).trim().slice(0, 40),
      default_current: Math.max(0, Math.min(maximum, current)),
      default_maximum: maximum,
      player_visible: resource.player_visible !== false,
      companion_visible: resource.companion_visible !== false,
    };
  }).slice(0, 20);
  const trackerBindingIds = (Array.isArray(sheet.trackers) ? sheet.trackers : []).map((tracker) => tracker?.tracker_id).filter((id) => typeof id === "string" && SAFE_ID.test(id));
  const bindingIds = new Set([...fields.map((field) => field.field_id), ...resources.map((resource) => resource.resource_id), ...trackerBindingIds, "conditions", "public_notes"]);
  const pages = uniqueDefinitions(sheet.pages, "page_id", "Page", (value) => {
    const page = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      page_id: cleanId(page.page_id, "page_id"),
      title: String(page.title ?? page.page_id).trim().slice(0, 40),
      bindings: [...new Set((Array.isArray(page.bindings) ? page.bindings : []).map(String).filter((binding) => bindingIds.has(binding)))].slice(0, 20),
    };
  }).slice(0, 12);
  const conditions = [...new Set((Array.isArray(sheet.conditions) ? sheet.conditions : []).map((condition) => String(condition).trim()).filter(Boolean))].slice(0, 50);
  const trackers = uniqueDefinitions(sheet.trackers, "tracker_id", "Tracker", (value) => {
    const tracker = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const visibleWhen = tracker.visible_when && typeof tracker.visible_when === "object" ? tracker.visible_when : null;
    return {
      tracker_id: cleanId(tracker.tracker_id, "tracker_id"),
      label: String(tracker.label ?? tracker.tracker_id).trim().slice(0, 40),
      type: "success_failure",
      success_target: Math.max(1, Math.min(10, Math.trunc(finiteNumber(tracker.success_target, 3)))),
      failure_target: Math.max(1, Math.min(10, Math.trunc(finiteNumber(tracker.failure_target, 3)))),
      critical_success_restores: Math.max(0, finiteNumber(tracker.critical_success_restores, 0)),
      critical_failure_count: Math.max(1, Math.min(10, Math.trunc(finiteNumber(tracker.critical_failure_count, 1)))),
      reset_on_resource_positive: Boolean(tracker.reset_on_resource_positive),
      visible_when: visibleWhen && resources.some((resource) => resource.resource_id === visibleWhen.resource_id) ? {
        resource_id: visibleWhen.resource_id,
        operator: ["lt", "lte", "eq", "gte", "gt"].includes(visibleWhen.operator) ? visibleWhen.operator : "lte",
        value: finiteNumber(visibleWhen.value),
      } : null,
    };
  }).slice(0, 10);
  const actions = uniqueDefinitions(sheet.actions, "action_id", "Action", (value) => {
    const action = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      action_id: cleanId(action.action_id, "action_id"),
      label: String(action.label ?? action.action_id).trim().slice(0, 40),
      kind: ["increment", "decrement", "toggle", "message"].includes(action.kind) ? action.kind : "message",
      target: typeof action.target === "string" && bindingIds.has(action.target) ? action.target : null,
    };
  }).slice(0, 20);
  return {
    system_id: existing?.system_id ?? input.system_id,
    name: String(input.name).trim().slice(0, 80),
    version: String(input.version ?? existing?.version ?? "1.0").trim().slice(0, 20),
    description: String(input.description ?? "").trim().slice(0, 500),
    character_sheet: { fields, resources, trackers, conditions, pages, actions },
    built_in: Boolean(existing?.built_in ?? builtIn),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

export function applyGameSystemDefaults(input, system) {
  if (!system) return input;
  const fields = Object.fromEntries(system.character_sheet.fields.map((field) => [field.field_id, field.default_value]));
  const resources = Object.fromEntries(system.character_sheet.resources.map((resource) => [resource.resource_id, {
    label: resource.label,
    current: resource.default_current,
    maximum: resource.default_maximum,
  }]));
  const trackers = Object.fromEntries((system.character_sheet.trackers ?? []).map((tracker) => [tracker.tracker_id, {
    ...tracker,
    successes: 0,
    failures: 0,
    status: "active",
  }]));
  return { ...input, fields: { ...fields, ...(input.fields ?? {}) }, resources: { ...resources, ...(input.resources ?? {}) }, trackers: { ...trackers, ...(input.trackers ?? {}) } };
}

export const BUILT_IN_GAME_SYSTEMS = [
  normalizeGameSystem({
    system_id: "custom", name: "Custom RPG", version: "1.0", built_in: true,
    description: "A lightweight system-neutral sheet for original and unsupported games.",
    character_sheet: {
      fields: [
        { field_id: "role", label: "Role / archetype", type: "text", section: "Identity" },
        { field_id: "level", label: "Level", type: "number", default_value: 1, section: "Identity" },
        { field_id: "defense", label: "Defense / armor", type: "text", section: "Combat" },
      ],
      resources: [{ resource_id: "health", label: "Health", default_current: 10, default_maximum: 10 }],
      pages: [{ page_id: "status", title: "Status", bindings: ["health", "conditions"] }],
      trackers: [], actions: [], conditions: [],
    },
  }, null, { builtIn: true }),
  normalizeGameSystem({
    system_id: "dnd5e", name: "Dungeons & Dragons 5e", version: "1.1", built_in: true,
    description: "A practical 5e foundation with core stats, health, and companion-ready pages.",
    character_sheet: {
      fields: [
        { field_id: "role", label: "Class", type: "text", section: "Identity" },
        { field_id: "level", label: "Level", type: "number", default_value: 1, section: "Identity" },
        { field_id: "defense", label: "Armor Class", type: "number", default_value: 10, section: "Combat" },
        ...["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"].map((fieldId) => ({ field_id: fieldId, label: fieldId[0].toUpperCase() + fieldId.slice(1), type: "number", default_value: 10, section: "Abilities" })),
      ],
      resources: [
        { resource_id: "health", label: "Hit Points", default_current: 10, default_maximum: 10 },
        { resource_id: "hit_dice", label: "Hit Dice", default_current: 1, default_maximum: 1 },
      ],
      trackers: [{ tracker_id: "death_saves", label: "Death Saves", success_target: 3, failure_target: 3, critical_success_restores: 1, critical_failure_count: 2, reset_on_resource_positive: true, visible_when: { resource_id: "health", operator: "lte", value: 0 } }],
      conditions: ["Blinded", "Charmed", "Deafened", "Frightened", "Grappled", "Incapacitated", "Invisible", "Paralyzed", "Poisoned", "Prone", "Restrained", "Stunned", "Unconscious"],
      pages: [
        { page_id: "status", title: "Status", bindings: ["health", "defense", "death_saves", "conditions"] },
        { page_id: "abilities", title: "Abilities", bindings: ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"] },
      ],
      actions: [
        { action_id: "damage", label: "Damage", kind: "decrement", target: "health" },
        { action_id: "heal", label: "Heal", kind: "increment", target: "health" },
      ],
    },
  }, null, { builtIn: true }),
];
