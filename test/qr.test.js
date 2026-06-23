import assert from "node:assert/strict";
import { test } from "node:test";
import { qrSvg } from "../core/public/assets/qr.js";

test("renders a self-contained campaign QR SVG", () => {
  const svg = qrSvg("http://sublim3-nexus.local:3000/player/?campaign=green_realm", { title:'Join "Green" <Realm>' });
  assert.match(svg, /^<svg/);
  assert.match(svg, /viewBox="0 0 49 49"/);
  assert.match(svg, /aria-label="Join &quot;Green&quot; &lt;Realm&gt;"/);
  assert.match(svg, /<path d="M/);
  assert.doesNotMatch(svg, /<Realm>/);
});

test("rejects player links beyond the fixed offline QR capacity", () => {
  assert.throws(() => qrSvg(`https://example.com/${"x".repeat(140)}`), /too long/);
});
