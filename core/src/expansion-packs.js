import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeGameSystem, validateGameSystem } from "./game-system.js";

const DEFAULT_PACK_DIRECTORY = fileURLToPath(new URL("../packs", import.meta.url));
const SAFE_ID = /^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/;

function text(value, fallback = "", maximum = 120) {
  return String(value ?? fallback).trim().slice(0, maximum);
}

function normalizeManifest(input, directoryName) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`Expansion pack ${directoryName} has an invalid manifest`);
  const packId = text(input.pack_id);
  const systemId = text(input.system_id);
  if (!SAFE_ID.test(packId) || packId !== directoryName) throw new Error(`Expansion pack directory ${directoryName} must match its pack_id`);
  if (!SAFE_ID.test(systemId)) throw new Error(`Expansion pack ${packId} has an invalid system_id`);
  return {
    pack_id: packId,
    system_id: systemId,
    name: text(input.name, packId, 80),
    version: text(input.version, "1.0", 20),
    schema_version: Math.max(1, Math.trunc(Number(input.schema_version) || 1)),
    minimum_nexus_version: text(input.minimum_nexus_version, "1.4.0", 20),
    description: text(input.description, "", 500),
    publisher: text(input.publisher, "SubLim3", 80),
    license: text(input.license, "Proprietary", 100),
    availability: "included",
    preinstalled: Boolean(input.preinstalled),
    experience: input.experience === "quick_start" ? "quick_start" : "customizable",
    price: null,
    tags: [...new Set((Array.isArray(input.tags) ? input.tags : []).map((tag) => text(tag, "", 30)).filter(Boolean))].slice(0, 12),
  };
}

export async function loadBundledExpansionPacks(directory = DEFAULT_PACK_DIRECTORY) {
  const entries = await readdir(directory, { withFileTypes: true });
  const packs = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const packDirectory = path.join(directory, entry.name);
    const [manifestInput, systemInput] = await Promise.all([
      readFile(path.join(packDirectory, "manifest.json"), "utf8").then(JSON.parse),
      readFile(path.join(packDirectory, "system.json"), "utf8").then(JSON.parse),
    ]);
    const manifest = normalizeManifest(manifestInput, entry.name);
    const errors = validateGameSystem(systemInput);
    if (errors.length) throw new Error(`Expansion pack ${manifest.pack_id}: ${errors.join("; ")}`);
    if (systemInput.system_id !== manifest.system_id) throw new Error(`Expansion pack ${manifest.pack_id} system_id does not match its manifest`);
    if (String(systemInput.version ?? "1.0") !== manifest.version) throw new Error(`Expansion pack ${manifest.pack_id} version does not match its system template`);
    const normalized = normalizeGameSystem(systemInput, null, { builtIn: true });
    const packSummary = { ...manifest };
    packs.push({ ...packSummary, system: { ...normalized, built_in: true, pack: packSummary } });
  }
  const systemIds = new Set();
  for (const pack of packs) {
    if (systemIds.has(pack.system_id)) throw new Error(`Multiple expansion packs provide ${pack.system_id}`);
    systemIds.add(pack.system_id);
  }
  return packs;
}
