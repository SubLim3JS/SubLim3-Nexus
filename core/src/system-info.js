import { statfs } from "node:fs/promises";
import os from "node:os";

export async function collectSystemInfo(dataDirectory) {
  const storage = await statfs(dataDirectory);
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    architecture: os.arch(),
    node_version: process.version,
    memory: {
      total_bytes: os.totalmem(),
      free_bytes: os.freemem(),
    },
    storage: {
      total_bytes: storage.blocks * storage.bsize,
      free_bytes: storage.bavail * storage.bsize,
    },
  };
}

