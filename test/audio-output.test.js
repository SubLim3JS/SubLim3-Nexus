import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { AudioService } from "../core/src/audio.js";
import { MpvAudioOutput, renderSynthesisWave } from "../core/src/platform/audio-output.js";
import { JsonStore } from "../core/src/storage/json-store.js";

const temporaryDirectories = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

test("renders playable PCM waves for built-in synthesis", () => {
  const wave = renderSynthesisWave({ item_id: "tone", kind: "effect", synthesis: { frequencies: [220, 330], wave: "sine", noise: 0.01, duration_seconds: 0.3 } });
  assert.equal(wave.toString("ascii", 0, 4), "RIFF");
  assert.equal(wave.toString("ascii", 8, 12), "WAVE");
  assert.ok(wave.length > 20_000);
  assert.ok(wave.subarray(44).some((value) => value !== 0));
});

test("uses mpv for Pi playback and falls back safely elsewhere", async () => {
  const fallback = new MpvAudioOutput({ platform: "win32", cacheDirectory: await temporaryDirectory("nexus-audio-fallback-") });
  await fallback.initialize();
  assert.equal(fallback.info().driver, "browser_preview");

  const calls = [];
  const children = [];
  const spawnProcess = (command, args) => {
    const child = new EventEmitter(); child.killedWith = null; child.kill = (signal) => { child.killedWith = signal; child.emit("close", 0); };
    calls.push({ command, args }); children.push(child); return child;
  };
  const output = new MpvAudioOutput({
    platform: "linux",
    command: "/usr/bin/mpv",
    audioDevice: "alsa/default",
    bluetoothAudioDevice: "alsa/bluealsa",
    cacheDirectory: await temporaryDirectory("nexus-audio-mpv-"),
    accessFile: async () => {},
    spawnProcess,
  });
  await output.initialize();
  assert.equal(output.info().driver, "mpv");
  await output.play({ item_id: "loop", kind: "ambience", loop: true, synthesis: { frequencies: [110] } }, { volume: 42, position: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/mpv");
  assert.ok(calls[0].args.includes("--loop-file=inf"));
  assert.ok(calls[0].args.includes("--volume=42"));
  assert.ok(calls[0].args.includes("--start=3"));
  assert.ok(calls[0].args.includes("--audio-device=alsa/default"));
  output.applyPreferences({ audio_output_device: "bluetooth" });
  assert.equal(output.info().output_device, "bluetooth");
  await output.play({ item_id: "bluetooth-loop", kind: "ambience", loop: true, synthesis: { frequencies: [110] } }, { volume: 42 });
  assert.ok(calls.at(-1).args.includes("--audio-device=alsa/bluealsa"));
  await output.stop();
  assert.equal(children[0].killedWith, "SIGTERM");
  await output.triggerEffect({ item_id: "hit", kind: "effect", synthesis: { frequencies: [440], duration_seconds: 0.25 } }, { volume: 60 });
  assert.equal(calls.length, 3);
  assert.ok(!calls.at(-1).args.includes("--loop-file=inf"));
  await output.applyPreferences({ audio_output_device: "browser" });
  assert.equal(output.info().output_device, "browser");
  assert.equal(output.info().server_playback, false);
  await output.play({ item_id: "local-loop", kind: "ambience", loop: true, synthesis: { frequencies: [110] } }, { volume: 42 });
  assert.equal(calls.length, 3);
});

test("falls back to Pi audio when Bluetooth output has no connected speaker", async () => {
  const calls = [];
  const spawnProcess = (command, args) => {
    const child = new EventEmitter(); child.kill = () => child.emit("close", 0);
    calls.push({ command, args }); return child;
  };
  const output = new MpvAudioOutput({
    platform: "linux",
    command: "/usr/bin/mpv",
    audioDevice: "alsa/default",
    bluetoothAudioDevice: "alsa/bluealsa",
    outputDevice: "bluetooth",
    cacheDirectory: await temporaryDirectory("nexus-audio-bluetooth-fallback-"),
    accessFile: async () => {},
    spawnProcess,
    bluetoothConnected: async () => false,
  });
  await output.initialize();
  assert.equal(output.info().output_device, "pi");
  assert.equal(output.info().preferred_output_device, "bluetooth");
  assert.equal(output.info().fallback_reason, "Bluetooth speaker not connected");
  await output.play({ item_id: "fallback-loop", kind: "ambience", loop: true, synthesis: { frequencies: [110] } }, { volume: 42 });
  assert.ok(calls.at(-1).args.includes("--audio-device=alsa/default"));
  assert.ok(!calls.at(-1).args.includes("--audio-device=alsa/bluealsa"));
});

test("routes AudioService controls to the configured server output", async () => {
  const directory = await temporaryDirectory("nexus-audio-service-");
  const calls = [];
  const output = {
    initialize: async () => calls.push(["initialize"]),
    info: () => ({ driver: "test", name: "Test output", available: true, server_playback: true }),
    play: async (item, options) => calls.push(["play", item.item_id, options.volume]),
    pause: async () => calls.push(["pause"]),
    stop: async () => calls.push(["stop"]),
    setVolume: async (volume) => calls.push(["volume", volume]),
    triggerEffect: async (item) => calls.push(["effect", item.item_id]),
  };
  const audio = new AudioService({
    libraryStore: new JsonStore(path.join(directory, "library")),
    stateStore: new JsonStore(path.join(directory, "state")),
    output,
  });
  await audio.initialize();
  assert.equal((await audio.status()).output.driver, "test");
  await audio.play("lantern-and-oak");
  await audio.pause();
  await audio.setVolume(35);
  await audio.triggerEffect("thunder");
  await audio.playRadio({ name: "Radio", url: "https://example.com/live" });
  await audio.stop();
  assert.deepEqual(calls.map((call) => call[0]), ["initialize", "play", "pause", "volume", "effect", "play", "stop"]);
  assert.equal(calls[1][1], "lantern-and-oak");
  assert.match(calls[5][1], /^radio-/);
});
