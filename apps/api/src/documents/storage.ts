import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const FILE_STORAGE = Symbol("FILE_STORAGE");

/** Private object storage. Keys are server-generated and never leave the API. */
export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Local-disk adapter for development and tests. Swap for a private S3 adapter in production. */
export class LocalFileStorage implements FileStorage {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const base = path.resolve(this.root);
    const full = path.resolve(base, key);
    if (!full.startsWith(base + path.sep)) throw new Error("invalid_storage_key");
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, { flag: "wx" });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

export function newObjectKey(tenantId: string): string {
  return `${tenantId}/${randomUUID()}`;
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
