import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "./errors.js";

// Opens a private SQLite file under <root>/.runtime with owner-only modes,
// refusing symlinks and hard links for the directory, database, and journals.
export function openPrivateDatabase(root: string, file: string, label: string): DatabaseSync {
  const directory = join(realpathSync(root), ".runtime");
  const database = join(directory, file);
  try {
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw new Error();
    mkdirSync(directory, {mode: 0o700});
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw new AppError("STORAGE", "Cannot create the private .runtime directory. It must be a local directory, not a symlink.");
    }
  }
  try {
    chmodSync(directory, 0o700);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const path = database + suffix;
      if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || lstatSync(path).nlink !== 1)) throw new Error();
    }
    const db = new DatabaseSync(database, {timeout: 5_000});
    chmodSync(database, 0o600);
    return db;
  } catch {
    throw new AppError("STORAGE", `Cannot open the private ${label}. Check file permissions and ledger schema version.`);
  }
}

// Read-only view for status-style commands: never creates .runtime or the
// file, and returns null when it does not exist yet.
export function readPrivateDatabase(root: string, file: string, label: string): DatabaseSync | null {
  const directory = join(realpathSync(root), ".runtime");
  const database = join(directory, file);
  if (!existsSync(database)) return null;
  try {
    if (lstatSync(directory).isSymbolicLink()) throw new Error();
    if (lstatSync(database).isSymbolicLink() || !lstatSync(database).isFile() || lstatSync(database).nlink !== 1) throw new Error();
    return new DatabaseSync(database, {readOnly: true, timeout: 5_000});
  } catch {
    throw new AppError("STORAGE", `Cannot read the private ${label}. Check file permissions.`);
  }
}
