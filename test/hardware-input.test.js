import test from "node:test";
import assert from "node:assert/strict";
import { applyHardwareAction, ButtonGestureInterpreter, shouldStartHardware } from "../core/src/platform/hardware-input.js";

function scheduler() {
  let nextId = 0;
  const jobs = new Map();
  return {
    set(fn) { const id = ++nextId; jobs.set(id, fn); return id; },
    clear(id) { jobs.delete(id); },
    runAll() { for (const [id, fn] of [...jobs]) { jobs.delete(id); fn(); } },
  };
}

test("maps button taps, holds, and double taps to media actions", () => {
  const timer = scheduler();
  const actions = [];
  const gestures = new ButtonGestureInterpreter({ onAction: (action) => actions.push(action), setTimer: timer.set, clearTimer: timer.clear });

  gestures.edge("volume_down", true);
  gestures.edge("volume_down", false);
  timer.runAll();
  assert.deepEqual(actions, ["volume_down"]);

  gestures.edge("volume_up", true);
  timer.runAll();
  gestures.edge("volume_up", false);
  assert.deepEqual(actions, ["volume_down", "next"]);

  gestures.edge("volume_down", true);
  gestures.edge("volume_down", false);
  gestures.edge("volume_down", true);
  gestures.edge("volume_down", false);
  timer.runAll();
  assert.deepEqual(actions, ["volume_down", "next", "toggle_playback"]);
});

test("applies physical media actions through the shared audio service", async () => {
  let status = { state: "playing", item_id: "one", external_item: null, volume: 50 };
  const played = [];
  const audio = {
    status: async () => status,
    setVolume: async (volume) => (status = { ...status, volume }),
    pause: async () => (status = { ...status, state: "paused" }),
    play: async (itemId) => { played.push(itemId); return (status = { ...status, state: "playing", item_id: itemId }); },
    library: async () => [{ item_id: "one" }, { item_id: "two" }, { item_id: "three" }],
  };
  const services = { audio, settings: async () => ({ maximum_volume: 80, volume_step: 10 }) };

  await applyHardwareAction("volume_up", services);
  assert.equal(status.volume, 60);
  await applyHardwareAction("next", services);
  assert.equal(status.item_id, "two");
  await applyHardwareAction("previous", services);
  assert.equal(status.item_id, "one");
  await applyHardwareAction("toggle_playback", services);
  assert.equal(status.state, "paused");
  await applyHardwareAction("toggle_playback", services);
  assert.equal(status.state, "playing");
  assert.deepEqual(played, ["two", "one", "one"]);
});

test("supports explicit Raspberry Pi hardware enable and disable modes", () => {
  assert.equal(shouldStartHardware("raspberry-pi"), true);
  assert.equal(shouldStartHardware("disabled"), false);
});
