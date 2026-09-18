import { snapshotSchema, validate } from "./domain.js";
import type { Snapshot } from "./domain.js";
import { readJson } from "./config.js";

export interface SnapshotSource {
  read(): Promise<Snapshot>;
}

export class FileSnapshotSource implements SnapshotSource {
  constructor(private readonly path: string) {}
  async read(): Promise<Snapshot> {
    return validate(snapshotSchema, await readJson(this.path), "Snapshot");
  }
}
