import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".flac", ".webm"]);

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readManifest(directory, fallback = {}) {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
    return { ...fallback, ...manifest };
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function countAudioFiles(directory) {
  let count = 0;
  const folders = new Set();
  const visit = async (current) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        count += 1;
        folders.add(path.relative(directory, current).replaceAll("\\", "/") || "Root");
      }
    }
  };
  await visit(directory);
  return { file_count: count, folder_count: folders.size };
}

function normalizeAudioPack(kind, packId, manifest, counts) {
  const commerce = manifest.commerce && typeof manifest.commerce === "object" && !Array.isArray(manifest.commerce)
    ? manifest.commerce
    : {};
  return {
    pack_id: packId,
    name: manifest.name ?? packId.replaceAll(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    version: manifest.version ?? "local",
    description: manifest.description ?? (kind === "game_audio" ? "Audio bundled with a game expansion pack." : "Shared optional expansion audio."),
    kind,
    availability: manifest.availability ?? "free",
    price: null,
    commerce: {
      model: commerce.model ?? "free_testing",
      label: commerce.label ?? "Free for testing",
      future_label: commerce.future_label ?? "Try them",
    },
    genre: manifest.genre ?? null,
    scene: manifest.scene ?? null,
    content_type: manifest.content_type ?? manifest.pack_type ?? null,
    mood: Array.isArray(manifest.mood) ? manifest.mood : [],
    recommended_for: Array.isArray(manifest.recommended_for) ? manifest.recommended_for : [],
    library_folder: manifest.library_folder ?? null,
    license: manifest.license ?? "Included for testing",
    credits: manifest.credits ?? null,
    sample_track: manifest.sample_track ?? null,
    tags: Array.isArray(manifest.tags) ? manifest.tags : [],
    ...counts,
  };
}

export async function loadAudioPackCatalog(sourceDirectory) {
  if (!sourceDirectory || !(await pathExists(sourceDirectory))) return [];
  const root = path.resolve(sourceDirectory);
  const packs = [];

  const audioPackRoot = path.join(root, "audio-packs");
  if (await pathExists(audioPackRoot)) {
    for (const entry of await readdir(audioPackRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = path.join(audioPackRoot, entry.name);
      const filesDirectory = path.join(directory, "files");
      if (!(await pathExists(filesDirectory))) continue;
      packs.push(normalizeAudioPack("audio", entry.name, await readManifest(directory), await countAudioFiles(filesDirectory)));
    }
  }

  const gamePackRoot = path.join(root, "packs");
  if (await pathExists(gamePackRoot)) {
    for (const entry of await readdir(gamePackRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = path.join(gamePackRoot, entry.name);
      const audioDirectory = path.join(directory, "audio");
      if (!(await pathExists(audioDirectory))) continue;
      const manifest = await readManifest(directory, { name: `${entry.name} Audio` });
      packs.push(normalizeAudioPack("game_audio", entry.name, manifest, await countAudioFiles(audioDirectory)));
    }
  }

  return packs
    .filter((pack) => pack.file_count > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}
