import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readFile, realpath, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

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
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_USB_FILES = 500;
const IMPORT_SOURCE = "sublim3-nexus-expansions";

function mediaError(message, statusCode = 422) {
  return Object.assign(new Error(message), { statusCode });
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeAudioFolder(value = "") {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return "";
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*\u0000-\u001f]/.test(segment))) {
    throw mediaError("Folder names cannot contain path traversal or reserved characters");
  }
  return segments.join("/");
}

function extensionFor(filename) {
  const extension = path.extname(String(filename ?? "")).toLowerCase();
  if (!AUDIO_TYPES.has(extension)) throw mediaError("Supported audio formats are MP3, WAV, OGG, Opus, M4A, AAC, FLAC, and WebM");
  return extension;
}

function displayName(filename) {
  return path.basename(filename, path.extname(filename)).replaceAll(/[_-]+/g, " ").trim() || "Untitled audio";
}

function titleCase(value) {
  return displayName(value).replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function itemIdFor(relativePath) {
  return `expansion-${createHash("sha1").update(relativePath.replaceAll("\\", "/").toLowerCase()).digest("hex").slice(0, 18)}`;
}

function kindFor(relativePath) {
  const normalized = relativePath.toLowerCase();
  return /(^|[/\\])(sfx|fx|effect|effects|sound effects?)([/\\]|$)/.test(normalized) ? "effect" : "ambience";
}

function expansionFolderFor(relativePath, manifest = null) {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  const libraryFolder = normalizeLibraryFolder(manifest?.library_folder);
  if (parts[0] === "packs" && parts[2] === "audio") return ["Expansion Audio", libraryFolder ?? titleCase(parts[1]), ...parts.slice(3, -1).map(titleCase)].join("/");
  if (parts[0] === "audio-packs" && parts[2] === "files") return ["Expansion Audio", libraryFolder ?? titleCase(parts[1]), ...parts.slice(3, -1).map(titleCase)].join("/");
  return ["Expansion Audio", ...parts.slice(0, -1).map(titleCase)].join("/");
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
  if (packId) tags.push(titleCase(packId));
  for (const value of manifest?.tags ?? []) if (typeof value === "string" && value && !tags.includes(value)) tags.push(value);
  for (const part of expansionFolderFor(relativePath, manifest).split("/").slice(-3)) {
    if (part && !tags.includes(part)) tags.push(part);
  }
  return tags;
}

function normalizeLibraryFolder(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.split(/[\\/]+/).map((part) => titleCase(part)).filter(Boolean).join("/");
}

async function readPackManifest(root, packId) {
  for (const relative of [
    path.join("audio-packs", packId, "manifest.json"),
    path.join("packs", packId, "manifest.json"),
  ]) {
    try {
      return JSON.parse(await readFile(path.join(root, relative), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

async function findPackFiles(rootDirectory, extensions) {
  const files = [];
  const visit = async (directory, depth = 0) => {
    if (depth > 12) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) files.push(target);
    }
  };
  await visit(rootDirectory);
  return files.sort((left, right) => left.localeCompare(right));
}

async function findCoverFiles(rootDirectory) {
  const covers = new Map();
  const visit = async (directory, depth = 0) => {
    if (depth > 12) return;
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

export class AudioFileService {
  constructor({ rootDirectory, libraryStore, usbRoots = [] }) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.libraryStore = libraryStore;
    this.usbRoots = usbRoots.map((root) => path.resolve(root));
  }

  async initialize() {
    await mkdir(this.rootDirectory, { recursive: true });
  }

  managedPath(relativePath = "") {
    const target = path.resolve(this.rootDirectory, ...String(relativePath).split("/").filter(Boolean));
    if (!within(this.rootDirectory, target)) throw mediaError("Managed audio path is invalid", 400);
    return target;
  }

  async folders() {
    const result = [""];
    const visit = async (directory, relative = "", depth = 0) => {
      if (depth >= 8 || result.length >= 500) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        result.push(child);
        await visit(path.join(directory, entry.name), child, depth + 1);
      }
    };
    await visit(this.rootDirectory);
    return result.sort((left, right) => left.localeCompare(right));
  }

  async createFolder(parentPath, name) {
    const parent = normalizeAudioFolder(parentPath);
    const cleanName = normalizeAudioFolder(name);
    if (!cleanName || cleanName.includes("/")) throw mediaError("Folder name must be one folder");
    const folderPath = parent ? `${parent}/${cleanName}` : cleanName;
    await mkdir(this.managedPath(folderPath), { recursive: true });
    return { folder_path: folderPath };
  }

  async saveUpload({ stream, filename, folderPath = "", kind = "ambience", contentType = null }) {
    if (!["ambience", "effect"].includes(kind)) throw mediaError("kind must be ambience or effect");
    const folder = normalizeAudioFolder(folderPath);
    const extension = extensionFor(filename);
    const itemId = `audio-${randomUUID()}`;
    const relativePath = folder ? `${folder}/${itemId}${extension}` : `${itemId}${extension}`;
    const destination = this.managedPath(relativePath);
    const temporary = `${destination}.upload`;
    await mkdir(path.dirname(destination), { recursive: true });
    let size = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(size > MAX_UPLOAD_BYTES ? mediaError("Audio file exceeds the 500 MB upload limit", 413) : null, chunk);
      },
    });
    try {
      await pipeline(stream, limiter, createWriteStream(temporary, { flags: "wx" }));
      if (size === 0) throw mediaError("Audio file is empty");
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    const now = new Date().toISOString();
    const item = {
      item_id: itemId,
      name: displayName(filename),
      kind,
      description: "Imported audio file",
      folder_path: folder,
      tags: [],
      duration_seconds: null,
      loop: kind === "ambience",
      built_in: false,
      source: {
        type: "file",
        relative_path: relativePath,
        original_filename: path.basename(filename),
        content_type: AUDIO_TYPES.get(extension) ?? contentType ?? "application/octet-stream",
        size_bytes: size,
      },
      created_at: now,
      updated_at: now,
    };
    await this.libraryStore.put(itemId, item);
    return item;
  }

  async move(itemId, folderPath) {
    const item = await this.libraryStore.get(itemId);
    if (!item || item.source?.type !== "file") throw mediaError("Audio file not found", 404);
    const folder = normalizeAudioFolder(folderPath);
    const filename = path.basename(item.source.relative_path);
    const relativePath = folder ? `${folder}/${filename}` : filename;
    const destination = this.managedPath(relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(this.managedPath(item.source.relative_path), destination);
    const updated = { ...item, folder_path: folder, source: { ...item.source, relative_path: relativePath }, updated_at: new Date().toISOString() };
    await this.libraryStore.put(item.item_id, updated);
    return updated;
  }

  async open(itemId) {
    const item = await this.libraryStore.get(itemId);
    if (!item || item.source?.type !== "file") throw mediaError("Audio file not found", 404);
    const filePath = this.managedPath(item.source.relative_path);
    const information = await stat(filePath);
    return { item, filePath, size: information.size, stream: (options) => createReadStream(filePath, options) };
  }

  async openCover(itemId) {
    const item = await this.libraryStore.get(itemId);
    if (!item?.artwork?.relative_path || item.artwork.type !== "file") throw mediaError("Audio cover art not found", 404);
    const filePath = this.managedPath(item.artwork.relative_path);
    const information = await stat(filePath);
    return { item, filePath, size: information.size, contentType: item.artwork.content_type ?? "image/jpeg", stream: (options) => createReadStream(filePath, options) };
  }

  async usbFiles() {
    const files = [];
    for (const configuredRoot of this.usbRoots) {
      let root;
      try { root = await realpath(configuredRoot); } catch { continue; }
      const visit = async (directory, depth = 0) => {
        if (depth >= 8 || files.length >= MAX_USB_FILES) return;
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (files.length >= MAX_USB_FILES || entry.name.startsWith(".")) break;
          const candidate = path.join(directory, entry.name);
          if (entry.isDirectory()) await visit(candidate, depth + 1);
          else if (entry.isFile() && AUDIO_TYPES.has(path.extname(entry.name).toLowerCase())) {
            files.push({ source_path: candidate, name: entry.name, location: path.relative(root, candidate).replaceAll("\\", "/"), usb_root: root });
          }
        }
      };
      await visit(root);
    }
    return files;
  }

  async resolveUsbSource(sourcePath) {
    let source;
    try { source = await realpath(String(sourcePath ?? "")); } catch { throw mediaError("USB audio file not found", 404); }
    let approved = false;
    for (const configuredRoot of this.usbRoots) {
      try {
        const root = await realpath(configuredRoot);
        if (within(root, source)) { approved = true; break; }
      } catch { /* Ignore unavailable mount roots. */ }
    }
    if (!approved) throw mediaError("USB source is outside the configured import roots", 403);
    const information = await stat(source);
    if (!information.isFile()) throw mediaError("USB source must be an audio file");
    const extension = extensionFor(source);
    return { source, information, contentType: AUDIO_TYPES.get(extension) };
  }

  async describeUsb(sourcePath) {
    const resolved = await this.resolveUsbSource(sourcePath);
    return {
      item_id: `usb-${randomUUID()}`,
      name: displayName(resolved.source),
      kind: "ambience",
      description: "Playing directly from USB",
      folder_path: "USB drive",
      tags: ["USB"],
      duration_seconds: null,
      loop: false,
      built_in: false,
      source: { type: "usb", source_path: resolved.source, original_filename: path.basename(resolved.source), content_type: resolved.contentType, size_bytes: resolved.information.size },
    };
  }

  async openUsb(sourcePath) {
    const resolved = await this.resolveUsbSource(sourcePath);
    return { filePath: resolved.source, size: resolved.information.size, contentType: resolved.contentType, stream: (options) => createReadStream(resolved.source, options) };
  }

  async importUsb({ sourcePath, folderPath = "", kind = "ambience" }) {
    const resolved = await this.resolveUsbSource(sourcePath);
    return this.saveUpload({ stream: createReadStream(resolved.source), filename: path.basename(resolved.source), folderPath, kind });
  }

  async importedExpansionItems(packId) {
    return (await this.libraryStore.list()).filter((item) => item.source?.imported_from === IMPORT_SOURCE && item.pack_id === packId);
  }

  async importedExpansionPacks() {
    const grouped = new Map();
    for (const item of await this.libraryStore.list()) {
      if (item.source?.imported_from !== IMPORT_SOURCE || !item.pack_id) continue;
      const existing = grouped.get(item.pack_id) ?? {
        pack_id: item.pack_id,
        name: titleCase(item.pack_id),
        version: item.source.imported_ref ?? "installed",
        description: "Installed expansion audio from the managed Media Library.",
        kind: "audio",
        availability: "installed",
        tags: ["Expansion"],
        file_count: 0,
        folder_count: 0,
        installed_file_count: 0,
        installed: true,
        enabled: true,
        folders: new Set(),
      };
      existing.file_count += 1;
      existing.installed_file_count += 1;
      if (item.folder_path) existing.folders.add(item.folder_path);
      grouped.set(item.pack_id, existing);
    }
    return [...grouped.values()].map(({ folders, ...pack }) => ({ ...pack, folder_count: folders.size }));
  }

  async importExpansionPack({ packId, sourceDirectory, repoUrl = null, ref = null }) {
    const root = path.resolve(sourceDirectory);
    const manifest = await readPackManifest(root, packId);
    const candidates = [
      path.join(root, "audio-packs", packId, "files"),
      path.join(root, "packs", packId, "audio"),
    ];
    const existingRoots = [];
    for (const candidate of candidates) {
      try {
        const information = await stat(candidate);
        if (information.isDirectory()) existingRoots.push(candidate);
      } catch { /* Missing pack roots are ignored. */ }
    }
    if (!existingRoots.length) throw mediaError("Audio pack not found", 404);

    const covers = new Map();
    for (const packRoot of existingRoots) {
      for (const [directory, cover] of await findCoverFiles(packRoot)) covers.set(directory, cover);
    }

    const imported = [];
    for (const packRoot of existingRoots) {
      const files = await findPackFiles(packRoot, AUDIO_TYPES);
      for (const sourcePath of files) {
        const relative = path.relative(root, sourcePath).replaceAll("\\", "/");
        const extension = path.extname(sourcePath).toLowerCase();
        const itemId = itemIdFor(relative);
        const kind = kindFor(relative);
        const folderPath = normalizeAudioFolder(expansionFolderFor(relative, manifest));
        const relativePath = normalizeAudioFolder(path.join(folderPath, `${itemId}${extension}`).replaceAll("\\", "/"));
        const destination = this.managedPath(relativePath);
        const info = await stat(sourcePath);
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(sourcePath, destination, { force: true });

        const coverPath = nearestCoverFor(sourcePath, packRoot, covers);
        let artwork = null;
        if (coverPath) {
          const coverExtension = path.extname(coverPath).toLowerCase();
          const coverRelativePath = normalizeAudioFolder(path.join(folderPath, `cover${coverExtension}`).replaceAll("\\", "/"));
          const coverDestination = this.managedPath(coverRelativePath);
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
        const item = {
          item_id: itemId,
          name: displayName(sourcePath),
          kind,
          description: "Optional audio imported from the SubLim3 Nexus expansions repository",
          folder_path: folderPath,
          pack_id: packId,
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
            imported_repo: repoUrl,
            imported_ref: ref,
            imported_source_path: relative,
          },
          created_at: now,
          updated_at: now,
        };
        await this.libraryStore.put(itemId, item);
        imported.push(item);
      }
    }
    return imported;
  }

  async removeExpansionPack(packId) {
    const items = await this.importedExpansionItems(packId);
    for (const item of items) {
      if (item.source?.relative_path) await rm(this.managedPath(item.source.relative_path), { force: true });
      if (item.artwork?.relative_path) await rm(this.managedPath(item.artwork.relative_path), { force: true });
      await this.libraryStore.delete(item.item_id);
      if (item.folder_path) await this.pruneEmptyFolders(item.folder_path);
    }
    return items.length;
  }

  async pruneEmptyFolders(folderPath) {
    let current = this.managedPath(normalizeAudioFolder(folderPath));
    const root = this.managedPath("Expansion Audio");
    while (within(root, current) && current !== root) {
      try { await rmdir(current); }
      catch { break; }
      current = path.dirname(current);
    }
  }
}
