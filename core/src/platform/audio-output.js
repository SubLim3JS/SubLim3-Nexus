import { spawn } from "node:child_process";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SAMPLE_RATE = 44_100;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function renderSynthesisWave(item) {
  const synthesis = item?.synthesis ?? {};
  const duration = clamp(Number(synthesis.duration_seconds) || (item?.kind === "effect" ? 1.5 : 8), 0.25, 12);
  const samples = Math.floor(SAMPLE_RATE * duration);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24); buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples * 2, 40);
  const frequencies = Array.isArray(synthesis.frequencies) && synthesis.frequencies.length ? synthesis.frequencies.map(Number).filter(Number.isFinite) : [220];
  let noiseState = 0x12345678;
  for (let index = 0; index < samples; index += 1) {
    const time = index / SAMPLE_RATE;
    let sample = 0;
    for (const frequency of frequencies) {
      const phase = time * frequency;
      if (synthesis.wave === "sawtooth") sample += 2 * (phase - Math.floor(phase + 0.5));
      else if (synthesis.wave === "square") sample += Math.sin(phase * Math.PI * 2) >= 0 ? 1 : -1;
      else sample += Math.sin(phase * Math.PI * 2);
    }
    sample = sample / Math.max(1, frequencies.length) * 0.28;
    noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
    sample += ((noiseState / 0xffffffff) * 2 - 1) * clamp(Number(synthesis.noise) || 0, 0, 0.5);
    if (synthesis.pulse) sample *= 0.62 + 0.38 * Math.max(0, Math.sin(time * Math.PI * 2 / Number(synthesis.pulse)));
    const fade = Math.min(1, index / 800, (samples - index - 1) / 800);
    buffer.writeInt16LE(Math.round(clamp(sample * fade, -1, 1) * 32767), 44 + index * 2);
  }
  return buffer;
}

export class BrowserAudioOutput {
  async initialize() {}
  info() { return { driver: "browser_preview", name: "Browser renderer", available: true, server_playback: false }; }
  async play() { return false; }
  async pause() { return false; }
  async stop() { return false; }
  async setVolume() { return false; }
  async triggerEffect() { return false; }
}

export class MpvAudioOutput {
  constructor({
    command = "/usr/bin/mpv",
    audioDevice = "auto",
    cacheDirectory,
    platform = process.platform,
    spawnProcess = spawn,
    accessFile = access,
  } = {}) {
    this.command = command;
    this.audioDevice = audioDevice;
    this.cacheDirectory = cacheDirectory;
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.accessFile = accessFile;
    this.available = false;
    this.child = null;
    this.effects = new Set();
    this.socketPath = path.join(os.tmpdir(), `sublim3-nexus-mpv-${process.pid}.sock`);
  }

  async initialize() {
    if (this.platform !== "linux" || !this.cacheDirectory) return;
    try {
      await this.accessFile(this.command, constants.X_OK);
      await mkdir(this.cacheDirectory, { recursive: true });
      this.available = true;
    } catch { this.available = false; }
  }

  info() {
    return this.available
      ? { driver: "mpv", name: this.audioDevice === "auto" ? "Raspberry Pi audio" : `Raspberry Pi audio · ${this.audioDevice}`, available: true, server_playback: true }
      : { driver: "browser_preview", name: "Browser renderer", available: true, server_playback: false };
  }

  async synthesisPath(item) {
    const filename = `${item.item_id}-${item.kind === "effect" ? "effect" : "loop"}.wav`;
    const destination = path.join(this.cacheDirectory, filename);
    try { if ((await stat(destination)).size > 44) return destination; } catch { /* Render below. */ }
    await writeFile(destination, renderSynthesisWave(item), { mode: 0o640 });
    return destination;
  }

  async sourceFor(item, files) {
    if (item?.source?.type === "radio") return item.source.stream_url;
    if (item?.source?.type === "usb") return item.source.source_path;
    if (item?.source?.type === "file") return (await files?.open(item.item_id))?.filePath ?? null;
    if (item?.synthesis) return this.synthesisPath(item);
    return null;
  }

  spawnItem(source, { loop = false, position = 0, volume = 50, ipc = false } = {}) {
    const args = ["--no-config", "--no-video", "--really-quiet", "--no-terminal", "--ao=alsa", `--volume=${Math.round(volume)}`];
    if (this.audioDevice !== "auto") args.push(`--audio-device=${this.audioDevice}`);
    if (position > 0) args.push(`--start=${position}`);
    if (loop) args.push("--loop-file=inf");
    if (ipc) args.push(`--input-ipc-server=${this.socketPath}`);
    args.push("--", source);
    const child = this.spawnProcess(this.command, args, { stdio: "ignore", windowsHide: true });
    child.on?.("error", () => {});
    return child;
  }

  async play(item, { files, position = 0, volume = 50 } = {}) {
    if (!this.available) return false;
    const source = await this.sourceFor(item, files);
    if (!source) return false;
    await this.stop();
    await rm(this.socketPath, { force: true }).catch(() => {});
    const child = this.spawnItem(source, { loop: Boolean(item.loop), position, volume, ipc: true });
    this.child = child;
    child.once?.("close", () => { if (this.child === child) this.child = null; });
    return true;
  }

  async sendOnce(command) {
    if (!this.available || !this.child) return false;
    return new Promise((resolve) => {
      const socket = net.createConnection(this.socketPath);
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 750);
      socket.once("connect", () => { socket.end(`${JSON.stringify({ command })}\n`); });
      socket.once("error", () => { clearTimeout(timer); resolve(false); });
      socket.once("close", () => { clearTimeout(timer); resolve(true); });
    });
  }

  async send(command) {
    if (!this.available || !this.child) return false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (await this.sendOnce(command)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async pause() { return this.send(["set_property", "pause", true]); }

  async stop() {
    if (!this.child) return false;
    const child = this.child; this.child = null;
    child.kill?.("SIGTERM");
    await rm(this.socketPath, { force: true }).catch(() => {});
    return true;
  }

  async setVolume(volume) { return this.send(["set_property", "volume", Math.round(volume)]); }

  async triggerEffect(item, { files, volume = 50 } = {}) {
    if (!this.available) return false;
    const source = await this.sourceFor(item, files);
    if (!source) return false;
    const child = this.spawnItem(source, { volume });
    this.effects.add(child);
    child.once?.("close", () => this.effects.delete(child));
    return true;
  }
}
