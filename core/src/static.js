import { readFile } from "node:fs/promises";
import path from "node:path";

const FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/admin", ["index.html", "text/html; charset=utf-8"]],
  ["/admin/", ["index.html", "text/html; charset=utf-8"]],
  ["/settings", ["settings.html", "text/html; charset=utf-8"]],
  ["/settings/", ["settings.html", "text/html; charset=utf-8"]],
  ["/settings/index.html", ["settings.html", "text/html; charset=utf-8"]],
  ["/media", ["media.html", "text/html; charset=utf-8"]],
  ["/media/", ["media.html", "text/html; charset=utf-8"]],
  ["/media/index.html", ["media.html", "text/html; charset=utf-8"]],
  ["/rfid", ["rfid.html", "text/html; charset=utf-8"]],
  ["/rfid/", ["rfid.html", "text/html; charset=utf-8"]],
  ["/rfid/index.html", ["rfid.html", "text/html; charset=utf-8"]],
  ["/library", ["library.html", "text/html; charset=utf-8"]],
  ["/library/", ["library.html", "text/html; charset=utf-8"]],
  ["/library/index.html", ["library.html", "text/html; charset=utf-8"]],
  ["/controllers", ["controllers.html", "text/html; charset=utf-8"]],
  ["/controllers/", ["controllers.html", "text/html; charset=utf-8"]],
  ["/controllers/index.html", ["controllers.html", "text/html; charset=utf-8"]],
  ["/packs", ["packs.html", "text/html; charset=utf-8"]],
  ["/packs/", ["packs.html", "text/html; charset=utf-8"]],
  ["/packs/index.html", ["packs.html", "text/html; charset=utf-8"]],
  ["/audio-packs", ["audio-packs.html", "text/html; charset=utf-8"]],
  ["/audio-packs/", ["audio-packs.html", "text/html; charset=utf-8"]],
  ["/audio-packs/index.html", ["audio-packs.html", "text/html; charset=utf-8"]],
  ["/player", ["player.html", "text/html; charset=utf-8"]],
  ["/player/", ["player.html", "text/html; charset=utf-8"]],
  ["/player/index.html", ["player.html", "text/html; charset=utf-8"]],
  ["/gm", ["gm.html", "text/html; charset=utf-8"]],
  ["/gm/", ["gm.html", "text/html; charset=utf-8"]],
  ["/gm/index.html", ["gm.html", "text/html; charset=utf-8"]],
  ["/assets/styles.css", ["assets/styles.css", "text/css; charset=utf-8"]],
  ["/assets/app.js", ["assets/app.js", "text/javascript; charset=utf-8"]],
  ["/assets/settings.css", ["assets/settings.css", "text/css; charset=utf-8"]],
  ["/assets/settings.js", ["assets/settings.js", "text/javascript; charset=utf-8"]],
  ["/assets/media.css", ["assets/media.css", "text/css; charset=utf-8"]],
  ["/assets/media.js", ["assets/media.js", "text/javascript; charset=utf-8"]],
  ["/assets/manage.css", ["assets/manage.css", "text/css; charset=utf-8"]],
  ["/assets/rfid.js", ["assets/rfid.js", "text/javascript; charset=utf-8"]],
  ["/assets/library.js", ["assets/library.js", "text/javascript; charset=utf-8"]],
  ["/assets/controllers.css", ["assets/controllers.css", "text/css; charset=utf-8"]],
  ["/assets/controllers.js", ["assets/controllers.js", "text/javascript; charset=utf-8"]],
  ["/assets/packs.js", ["assets/packs.js", "text/javascript; charset=utf-8"]],
  ["/assets/player.css", ["assets/player.css", "text/css; charset=utf-8"]],
  ["/assets/player.js", ["assets/player.js", "text/javascript; charset=utf-8"]],
  ["/assets/gm.css", ["assets/gm.css", "text/css; charset=utf-8"]],
  ["/assets/gm.js", ["assets/gm.js", "text/javascript; charset=utf-8"]],
  ["/assets/qr.js", ["assets/qr.js", "text/javascript; charset=utf-8"]],
  ["/assets/nexus-logo.png", ["assets/nexus-logo.png", "image/png"]],
]);

export async function serveStatic(pathname, response, publicDirectory) {
  const target = FILES.get(pathname);
  if (!target) return false;

  const [relativePath, contentType] = target;
  const content = await readFile(path.join(publicDirectory, relativePath));
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": content.length,
    "cache-control": "no-cache",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' http: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(content);
  return true;
}
