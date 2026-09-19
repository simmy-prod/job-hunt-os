import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveryReview, Listing } from "./domain.js";
import { listingSchema, validate } from "./domain.js";
import { AppError } from "./errors.js";
import type { NormalizedListing } from "./normalize.js";

export interface MergeSummary {
  added: string[];
  changed: string[];
  unchanged: string[];
}

export interface StoredReview {
  sourceId: string;
  externalId: string;
  reason: string;
  firstObservedAt: string;
  lastObservedAt: string;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

// Private, local persistence for discovered listings and the open review
// queue, at .runtime/discovery.sqlite (same private directory and safety
// rules as src/ledger.ts's runs.sqlite: never a symlink, never multi-linked,
// mode 0700/0600). Separate database file from runs.sqlite: discovery state
// and morning-plan run history are independent concerns that should not
// share a schema migration path.
export class DiscoveryStore {
  private readonly db: DatabaseSync;

  constructor(root: string) {
    const directory = join(realpathSync(root), ".runtime");
    const database = join(directory, "discovery.sqlite");
    try {
      if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw new Error();
      mkdirSync(directory, {mode: 0o700});
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw new AppError("STORAGE", "Cannot create the private .runtime directory. It must be a local directory, not a symlink.");
      }
    }
    try {
      chmodSync(directory, 0o700);
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        const path = database + suffix;
        if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || lstatSync(path).nlink !== 1)) throw new Error();
      }
      this.db = new DatabaseSync(database, {timeout: 5_000});
      chmodSync(database, 0o600);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS listings (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          external_id TEXT NOT NULL,
          title TEXT NOT NULL,
          company TEXT NOT NULL,
          canonical_url TEXT NOT NULL,
          locations_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS reviews (
          source_id TEXT NOT NULL,
          external_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          first_observed_at TEXT NOT NULL,
          last_observed_at TEXT NOT NULL,
          PRIMARY KEY (source_id, external_id)
        ) STRICT;
      `);
    } catch {
      throw new AppError("STORAGE", "Cannot open the private discovery store. Check file permissions and store schema.");
    }
  }

  // Upserts by stable listing id (sourceId:externalId), never by row order.
  // A listing whose content changed keeps its identity and first_seen_at;
  // only last_seen_at and the changed fields move, so a re-fetched listing
  // never forks into a duplicate row. A listing not present in `incoming`
  // (a different source's page, or a source that failed this run) is left
  // untouched: a source being unavailable must never erase prior history.
  mergeListings(incoming: readonly NormalizedListing[], observedAt: string): MergeSummary {
    const summary: MergeSummary = {added: [], changed: [], unchanged: []};
    try {
      this.db.exec("BEGIN IMMEDIATE");
      for (const listing of incoming) {
        const previous = this.db.prepare("SELECT content_hash, first_seen_at FROM listings WHERE id = ?").get(listing.id) as
          {content_hash: string; first_seen_at: string} | undefined;
        const firstSeenAt = previous?.first_seen_at ?? observedAt;
        this.db.prepare(`INSERT INTO listings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title, company=excluded.company,
            canonical_url=excluded.canonical_url, locations_json=excluded.locations_json,
            content_hash=excluded.content_hash, last_seen_at=excluded.last_seen_at`).run(
          listing.id, listing.sourceId, listing.externalId, listing.title, listing.company,
          listing.canonicalUrl, JSON.stringify(listing.locations), listing.contentHash, firstSeenAt, observedAt,
        );
        if (!previous) summary.added.push(listing.id);
        else if (previous.content_hash !== listing.contentHash) summary.changed.push(listing.id);
        else summary.unchanged.push(listing.id);
        // A listing that now normalizes cleanly is no longer an open review.
        this.db.prepare("DELETE FROM reviews WHERE source_id = ? AND external_id = ?").run(listing.sourceId, listing.externalId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (error instanceof AppError) throw error;
      throw new AppError("STORAGE", "Could not atomically record discovered listings. No partial update was applied.");
    }
    return summary;
  }

  // Reviews without a usable externalId are not persisted: there is no
  // stable key to upsert against, so they can only ever be reported for the
  // run that observed them (see src/discovery.ts's run summary).
  upsertReviews(reviews: readonly DiscoveryReview[]): void {
    const identifiable = reviews.filter((review): review is DiscoveryReview & {externalId: string} => review.externalId !== null);
    if (identifiable.length === 0) return;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      for (const review of identifiable) {
        const previous = this.db.prepare("SELECT first_observed_at FROM reviews WHERE source_id = ? AND external_id = ?")
          .get(review.sourceId, review.externalId) as {first_observed_at: string} | undefined;
        this.db.prepare(`INSERT INTO reviews VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(source_id, external_id) DO UPDATE SET reason=excluded.reason, last_observed_at=excluded.last_observed_at`).run(
          review.sourceId, review.externalId, review.reason, previous?.first_observed_at ?? review.observedAt, review.observedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw new AppError("STORAGE", "Could not atomically record the discovery review queue.");
    }
  }

  listListings(): Listing[] {
    const rows = this.db.prepare("SELECT * FROM listings ORDER BY id").all() as Array<Record<string, unknown>>;
    return rows.map((row) => validate(listingSchema, {
      id: row.id, sourceId: row.source_id, externalId: row.external_id, title: row.title, company: row.company,
      canonicalUrl: row.canonical_url, locations: JSON.parse(row.locations_json as string) as unknown, contentHash: row.content_hash,
      firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    }, "Stored listing"));
  }

  listReviews(): StoredReview[] {
    const rows = this.db.prepare("SELECT * FROM reviews ORDER BY source_id, external_id").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sourceId: row.source_id as string, externalId: row.external_id as string, reason: row.reason as string,
      firstObservedAt: row.first_observed_at as string, lastObservedAt: row.last_observed_at as string,
    }));
  }

  close(): void {
    this.db.close();
  }
}
