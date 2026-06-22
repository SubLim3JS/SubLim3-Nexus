import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveEvents } from "../core/src/live-events.js";

test("publishes session changes only to the matching campaign", () => {
  const events = new LiveEvents();
  const received = [];
  const unsubscribe = events.subscribe("green", (session) => received.push(session));
  events.publish("red", { mode: "battle" });
  events.publish("green", { mode: "game" });
  unsubscribe();
  events.publish("green", { mode: "battle" });
  assert.deepEqual(received, [{ mode: "game" }]);
});
