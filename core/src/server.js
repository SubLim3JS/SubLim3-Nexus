import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { JsonStore } from "./storage/json-store.js";
import { collectSystemInfo } from "./system-info.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.NEXUS_DATA_DIR ?? path.resolve(directory, "../data");
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const campaignStore = new JsonStore(path.join(dataDirectory, "campaigns"));
await campaignStore.initialize();

const server = createServer(createApp({
  campaignStore,
  getSystemInfo: () => collectSystemInfo(dataDirectory),
}));
server.listen(port, host, () => {
  console.log(`Nexus Core listening on http://${host}:${port}`);
});
