import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUTTONS = Object.freeze({
  volume_down: { tap: "volume_down", hold: "previous" },
  volume_up: { tap: "volume_up", hold: "next" },
});

export class ButtonGestureInterpreter {
  constructor({ onAction, doubleTapMs = 350, holdMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.onAction = onAction;
    this.doubleTapMs = doubleTapMs;
    this.holdMs = holdMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.buttons = new Map();
  }

  state(name) {
    if (!this.buttons.has(name)) this.buttons.set(name, { pressed: false, held: false, taps: 0, holdTimer: null, tapTimer: null });
    return this.buttons.get(name);
  }

  edge(name, pressed) {
    const definition = BUTTONS[name];
    if (!definition) return false;
    const state = this.state(name);
    if (pressed === state.pressed) return true;
    state.pressed = pressed;

    if (pressed) {
      state.held = false;
      state.holdTimer = this.setTimer(() => {
        if (!state.pressed) return;
        state.held = true;
        state.taps = 0;
        this.clearTimer(state.tapTimer);
        state.tapTimer = null;
        this.onAction(definition.hold);
      }, this.holdMs);
      state.holdTimer.unref?.();
      return true;
    }

    this.clearTimer(state.holdTimer);
    state.holdTimer = null;
    if (state.held) return true;
    state.taps += 1;
    if (state.taps >= 2) {
      this.clearTimer(state.tapTimer);
      state.tapTimer = null;
      state.taps = 0;
      this.onAction("toggle_playback");
      return true;
    }
    state.tapTimer = this.setTimer(() => {
      state.taps = 0;
      state.tapTimer = null;
      this.onAction(definition.tap);
    }, this.doubleTapMs);
    state.tapTimer.unref?.();
    return true;
  }

  close() {
    for (const state of this.buttons.values()) {
      this.clearTimer(state.holdTimer);
      this.clearTimer(state.tapTimer);
    }
    this.buttons.clear();
  }
}

export async function applyHardwareAction(action, { audio, settings }) {
  const preferences = await settings();
  const status = await audio.status();
  if (action === "volume_up" || action === "volume_down") {
    const direction = action === "volume_up" ? 1 : -1;
    return audio.setVolume(Math.max(0, Math.min(preferences.maximum_volume, status.volume + direction * preferences.volume_step)));
  }
  if (action === "toggle_playback") {
    if (status.state === "playing") return audio.pause();
    if (status.item_id && !status.external_item) return audio.play(status.item_id);
    return status;
  }
  if (action === "next" || action === "previous") {
    const items = await audio.library("ambience");
    if (!items.length) return status;
    const current = items.findIndex((item) => item.item_id === status.item_id);
    const offset = action === "next" ? 1 : -1;
    const index = current < 0 ? (offset > 0 ? 0 : items.length - 1) : (current + offset + items.length) % items.length;
    return audio.play(items[index].item_id);
  }
  return status;
}

function raspberryPiModel() {
  try {
    return readFileSync("/proc/device-tree/model", "utf8").includes("Raspberry Pi");
  } catch { return false; }
}

export function shouldStartHardware(driver = process.env.NEXUS_HARDWARE_DRIVER ?? "auto") {
  if (["disabled", "off", "none"].includes(driver.toLowerCase())) return false;
  if (["raspberry-pi", "rpi"].includes(driver.toLowerCase())) return true;
  return process.platform === "linux" && raspberryPiModel();
}

export class HardwareInputService {
  constructor({ rfid, audio, settings, scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/rpi-hardware.py"), python = process.env.NEXUS_PYTHON_PATH ?? "/usr/bin/python3", cwd = process.env.NEXUS_DATA_DIR ?? "/tmp", spawnProcess = spawn, logger = console }) {
    this.rfid = rfid;
    this.audio = audio;
    this.settings = settings;
    this.scriptPath = scriptPath;
    this.python = python;
    this.cwd = cwd;
    this.spawnProcess = spawnProcess;
    this.logger = logger;
    this.child = null;
    this.stopped = true;
    this.restartTimer = null;
    this.pending = Promise.resolve();
    this.gestures = new ButtonGestureInterpreter({
      onAction: (action) => {
        this.logger.error(`Hardware button action: ${action}`);
        return this.enqueue(() => applyHardwareAction(action, this));
      },
    });
  }

  enqueue(operation) {
    this.pending = this.pending.then(operation).catch((error) => this.logger.error(`Hardware input failed: ${error.message}`));
    return this.pending;
  }

  event(input) {
    if (input?.type === "rfid" && input.uid) return this.enqueue(() => this.rfid.scan({ uid: input.uid, present: input.present !== false }));
    if (input?.type === "button" && typeof input.name === "string" && typeof input.pressed === "boolean") return this.gestures.edge(input.name, input.pressed);
    return false;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.launch();
  }

  launch() {
    if (this.stopped) return;
    const child = this.spawnProcess(this.python, [this.scriptPath], { cwd: this.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        try { this.event(JSON.parse(line)); }
        catch { this.logger.error(`Ignoring invalid hardware event: ${line.slice(0, 160)}`); }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.logger.error(`Raspberry Pi hardware: ${chunk.trim()}`));
    child.on("error", (error) => this.logger.error(`Raspberry Pi hardware could not start: ${error.message}`));
    child.on("close", (code) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      this.logger.error(`Raspberry Pi hardware exited (${code ?? "signal"}); retrying in 5 seconds.`);
      this.restartTimer = setTimeout(() => this.launch(), 5_000);
      this.restartTimer.unref?.();
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.gestures.close();
    this.child?.kill("SIGTERM");
    this.child = null;
  }
}
