import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, realpath, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_USB_FILES = 500;

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
}
