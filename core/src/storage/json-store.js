import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const SAFE_ID = /^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/;

export class JsonStore {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }

  async initialize() {
    await mkdir(this.rootDirectory, { recursive: true });
  }

  validateId(id) {
    if (!SAFE_ID.test(id)) {
      const error = new Error("ID must use lowercase letters, numbers, hyphens, or underscores");
      error.statusCode = 400;
      throw error;
    }
  }

  filePath(id) {
    this.validateId(id);
    return path.join(this.rootDirectory, `${id}.json`);
  }

  async list() {
    await this.initialize();
    const files = (await readdir(this.rootDirectory)).filter((file) => file.endsWith(".json"));
    const records = await Promise.all(files.map(async (file) => {
      const content = await readFile(path.join(this.rootDirectory, file), "utf8");
      return JSON.parse(content);
    }));
    return records.sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(id) {
    try {
      return JSON.parse(await readFile(this.filePath(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async put(id, record) {
    await this.initialize();
    const destination = this.filePath(id);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
    return record;
  }

  async delete(id) {
    try {
      await unlink(this.filePath(id));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
}

