#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore } from "../core/src/storage/json-store.js";
import { normalizeAudioFolder } from "../core/src/audio-files.js";

const execFile = promisify(execFileCallback);
const DEFAULT_REPO_URL = "https://github.com/SubLim3JS/SubLim3-Nexus-Expansions.git";
const DEFAULT_REF = "main";
const IMPORT_SOURCE = "sublim3-nexus-expansions";
const AUDIO_TYPES = new Map([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".webm", "audio/webm"],
]);
const COVER_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

function usage() {
  console.log(`Usage:
  node scripts/import-expansion-audio.mjs [--source <path>] [--data-dir <path>] [--repo <url>] [--ref <git-ref>]
  node scripts/import-expansion-audio.mjs --remove [--data-dir <path>]

Imports optional audio from the SubLim3 Nexus expansions repository into the managed Nexus audio library.

Recommended expansion repo audio paths:
  packs/<pack_id>/audio/<queue-or-scene-folder>/<file>
  audio-packs/<audio_pack_id>/files/<queue-or-scene-folder>/<file>

Options:
  --source   Use an existing local clone instead of cloning/fetching the repo.
  --data-dir Nexus data directory. Defaults to NEXUS_DATA_DIR or core/data.
  --repo     Expansion repository URL. Defaults to ${DEFAULT_REPO_URL}.
  --ref      Git branch/tag/commit to fetch when cloning. Defaults to ${DEFAULT_REF}.
  --remove   Remove previously imported expansion audio from the managed library.`);
}

function parseArgs(argv) {
  const options = {
    ref: process.env.NEXUS_EXPANSIONS_REF ?? DEFAULT_REF,
    repoUrl: process.env.NEXUS_EXPANSIONS_REPO ?? DEFAULT_REPO_URL,
    dataDirectory: process.env.NEXUS_DATA_DIR ? path.resolve(process.env.NEXUS_DATA_DIR) : path.resolve(projectRoot, "core/data"),
    sourceDirectory: null,
    remove: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--remove") options.remove = true;
    else if (arg === "--source") options.sourceDirectory = path.resolve(argv[++index] ?? "");
    else if (arg === "--data-dir") options.dataDirectory = path.resolve(argv[++index] ?? "");
    else if (arg === "--repo") options.repoUrl = argv[++index] ?? DEFAULT_REPO_URL;
    else if (arg === "--ref") options.ref = argv[++index] ?? DEFAULT_REF;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function runGit(args, cwd = projectRoot) {
  const { stdout, stderr } = await execFile("git", args, { cwd, windowsHide: true });
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
}

async function ensureSource(options) {
  if (options.sourceDirectory) {
    if (!(await pathExists(options.sourceDirectory))) throw new Error(`Source directory not found: ${options.sourceDirectory}`);
    return options.sourceDirectory;
  }

  const cacheDirectory = path.join(options.dataDirectory, "expansions", "repo-cache");
  if (await pathExists(path.join(cacheDirectory, ".git"))) {
    console.log(`Updating existing expansions clone in ${cacheDirectory}…`);
    await runGit(["remote", "set-url", "origin", options.repoUrl], cacheDirectory);
    await runGit(["fetch", "--depth", "1", "origin", options.ref], cacheDirectory);
    await runGit(["checkout", "--detach", "FETCH_HEAD"], cacheDirectory);
  } else {
    await rm(cacheDirectory, { recursive: true, force: true });
    await mkdir(path.dirname(cacheDirectory), { recursive: true });
    console.log(`Cloning expansions into ${cacheDirectory}…`);
    await runGit(["clone", "--depth", "1", "--branch", options.ref, options.repoUrl, cacheDirectory]);
  }
  return cacheDirectory;
}

async function findAudioFiles(rootDirectory) {
  const files = [];
  const visit = async (directory, depth = 0) => {
    if (depth > 14) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile() && AUDIO_TYPES.has(path.extname(entry.name).toLowerCase())) files.push(target);
    }
  };
  await visit(rootDirectory);
  return files.sort((left, right) => left.localeCompare(right));
}

async function findCoverFiles(rootDirectory) {
  const covers = new Map();
  const visit = async (directory, depth = 0) => {
    if (depth > 14) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile() && /^cover\.(jpe?g|png|webp)$/i.test(entry.name)) covers.set(directory, target);
    }
  };
  await visit(rootDirectory);
  return covers;
}

function titleFromFilename(filename) {
  return path.basename(filename, path.extname(filename)).replaceAll(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Expansion audio";
}

function cleanSegment(value) {
  return titleFromFilename(value).replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function itemIdFor(relativePath) {
  return `expansion-${createHash("sha1").update(relativePath.replaceAll("\\", "/").toLowerCase()).digest("hex").slice(0, 18)}`;
}

function kindFor(relativePath) {
  const normalized = relativePath.toLowerCase();
  return /(^|[/\\])(sfx|fx|effect|effects|sound effects?)([/\\]|$)/.test(normalized) ? "effect" : "ambience";
}

function normalizeLibraryFolder(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.split(/[\\/]+/).map((part) => cleanSegment(part)).filter(Boolean).join("/");
}

async function readPackManifest(rootDirectory, relativePath) {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  const packId = packIdFor(relativePath);
  if (!packId) return null;
  const manifestPath = parts[0] === "audio-packs"
    ? path.join(rootDirectory, "audio-packs", packId, "manifest.json")
    : path.join(rootDirectory, "packs", packId, "manifest.json");
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function expansionFolderFor(relativePath, manifest = null) {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  const libraryFolder = normalizeLibraryFolder(manifest?.library_folder);
  if (parts[0] === "packs" && parts[2] === "audio") return ["Expansion Audio", libraryFolder ?? cleanSegment(parts[1]), ...parts.slice(3, -1).map(cleanSegment)].join("/");
  if (parts[0] === "audio-packs" && parts[2] === "files") return ["Expansion Audio", libraryFolder ?? cleanSegment(parts[1]), ...parts.slice(3, -1).map(cleanSegment)].join("/");
  return ["Expansion Audio", ...parts.slice(0, -1).map(cleanSegment)].join("/");
}

function packIdFor(relativePath) {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts[0] === "packs" && parts[2] === "audio") return parts[1];
  if (parts[0] === "audio-packs" && parts[2] === "files") return parts[1];
  return null;
}

function tagsFor(relativePath, kind, manifest = null) {
  const tags = ["Expansion", kind === "effect" ? "Effect" : "Ambience"];
  const packId = packIdFor(relativePath);
  if (packId) tags.push(cleanSegment(packId));
  for (const value of manifest?.tags ?? []) if (typeof value === "string" && value && !tags.includes(value)) tags.push(value);
  const sceneParts = expansionFolderFor(relativePath, manifest).split("/").slice(-3);
  for (const part of sceneParts) if (part && !tags.includes(part)) tags.push(part);
  return tags;
}

function nearestCoverFor(sourcePath, rootDirectory, covers) {
  let directory = path.dirname(sourcePath);
  while (directory.startsWith(rootDirectory)) {
    if (covers.has(directory)) return covers.get(directory);
    const next = path.dirname(directory);
    if (next === directory) break;
    directory = next;
  }
  return null;
}

async function importAudio(options) {
  const sourceDirectory = await ensureSource(options);
  const files = await findAudioFiles(sourceDirectory);
  const covers = await findCoverFiles(sourceDirectory);
  const libraryStore = new JsonStore(path.join(options.dataDirectory, "audio", "library"));
  const managedRoot = path.join(options.dataDirectory, "audio", "files");
  await Promise.all([libraryStore.initialize(), mkdir(managedRoot, { recursive: true })]);

  let imported = 0;
  for (const sourcePath of files) {
    const relative = path.relative(sourceDirectory, sourcePath).replaceAll("\\", "/");
    const extension = path.extname(sourcePath).toLowerCase();
    const itemId = itemIdFor(relative);
    const kind = kindFor(relative);
    const manifest = await readPackManifest(sourceDirectory, relative);
    const folderPath = normalizeAudioFolder(expansionFolderFor(relative, manifest));
    const relativePath = normalizeAudioFolder(path.join(folderPath, `${itemId}${extension}`).replaceAll("\\", "/"));
    const destination = path.join(managedRoot, ...relativePath.split("/"));
    const info = await stat(sourcePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(sourcePath, destination, { force: true });
    const coverPath = nearestCoverFor(sourcePath, sourceDirectory, covers);
    let artwork = null;
    if (coverPath) {
      const coverExtension = path.extname(coverPath).toLowerCase();
      const coverRelativePath = normalizeAudioFolder(path.join(folderPath, `cover${coverExtension}`).replaceAll("\\", "/"));
      const coverDestination = path.join(managedRoot, ...coverRelativePath.split("/"));
      const coverInfo = await stat(coverPath);
      await cp(coverPath, coverDestination, { force: true });
      artwork = {
        type: "file",
        relative_path: coverRelativePath,
        original_filename: path.basename(coverPath),
        content_type: COVER_TYPES.get(coverExtension) ?? "image/jpeg",
        size_bytes: coverInfo.size,
      };
    }
    const now = new Date().toISOString();
    await libraryStore.put(itemId, {
      item_id: itemId,
      name: titleFromFilename(sourcePath),
      kind,
      description: "Optional audio imported from the SubLim3 Nexus expansions repository",
      folder_path: folderPath,
      pack_id: packIdFor(relative),
      tags: tagsFor(relative, kind, manifest),
      duration_seconds: null,
      loop: kind === "ambience",
      built_in: false,
      ...(artwork ? { artwork } : {}),
      source: {
        type: "file",
        relative_path: relativePath,
        original_filename: path.basename(sourcePath),
        content_type: AUDIO_TYPES.get(extension),
        size_bytes: info.size,
        imported_from: IMPORT_SOURCE,
        imported_repo: options.repoUrl,
        imported_ref: options.ref,
        imported_source_path: relative,
      },
      created_at: now,
      updated_at: now,
    });
    imported += 1;
  }

  console.log(`Imported ${imported} expansion audio file${imported === 1 ? "" : "s"} into ${options.dataDirectory}.`);
}

async function removeImportedAudio(options) {
  const libraryStore = new JsonStore(path.join(options.dataDirectory, "audio", "library"));
  await libraryStore.initialize();
  const items = await libraryStore.list();
  let removed = 0;
  for (const item of items) {
    if (item.source?.imported_from !== IMPORT_SOURCE || item.source?.type !== "file") continue;
    if (item.source.relative_path) await rm(path.join(options.dataDirectory, "audio", "files", ...item.source.relative_path.split("/")), { force: true });
    await libraryStore.delete(item.item_id);
    removed += 1;
  }
  await rm(path.join(options.dataDirectory, "audio", "files", "Expansion Audio"), { recursive: true, force: true });
  console.log(`Removed ${removed} expansion audio item${removed === 1 ? "" : "s"} from ${options.dataDirectory}.`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) usage();
  else if (options.remove) await removeImportedAudio(options);
  else await importAudio(options);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
