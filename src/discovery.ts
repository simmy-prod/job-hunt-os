import type { DiscoveryReview, MatchDecision } from "./domain.js";
import type { DiscoveryStore } from "./discoveryStore.js";
import type { ErrorCode } from "./errors.js";
import { safeError } from "./errors.js";
import type { JobSourceAdapter } from "./jobSource.js";
import { fetchAllListings } from "./jobSource.js";
import type { MatchingConfig } from "./matchingConfig.js";
import { evaluateMatch, normalizeBatch } from "./normalize.js";

export interface SourceOutcome {
  sourceId: string;
  ok: boolean;
  errorCode: ErrorCode | null;
  fetched: number;
  duplicatesInBatch: number;
}

export interface DiscoveryRun {
  observedAt: string;
  sources: SourceOutcome[];
  added: string[];
  changed: string[];
  decisions: MatchDecision[];
  reviews: DiscoveryReview[];
}

// Runs every adapter independently and merges into the store as each one
// finishes: one job source being down, rate-limited, or returning malformed
// pages must never block or corrupt another source's results, and must never
// erase listings previously discovered from the failed source (mergeListings
// only ever touches rows for ids it was actually given this run). No Notion
// write, application submission, or message is possible from this function;
// it only reads adapters and writes the local discovery store.
export async function runDiscovery(options: {
  adapters: readonly JobSourceAdapter[];
  store: DiscoveryStore;
  matching: MatchingConfig;
  observedAt: string;
}): Promise<DiscoveryRun> {
  const sources: SourceOutcome[] = [];
  const reviews: DiscoveryReview[] = [];
  const added: string[] = [];
  const changed: string[] = [];
  const decisions: MatchDecision[] = [];

  for (const adapter of options.adapters) {
    try {
      const rawListings = await fetchAllListings(adapter);
      const batch = normalizeBatch(rawListings, adapter.sourceId, options.observedAt);
      const summary = options.store.mergeListings(batch.listings, options.observedAt);
      options.store.upsertReviews(batch.reviews);
      added.push(...summary.added);
      changed.push(...summary.changed);
      reviews.push(...batch.reviews);
      for (const listing of batch.listings) decisions.push(evaluateMatch(listing, options.matching));
      sources.push({sourceId: adapter.sourceId, ok: true, errorCode: null, fetched: rawListings.length, duplicatesInBatch: batch.duplicatesInBatch});
    } catch (error) {
      const failure = safeError(error);
      sources.push({sourceId: adapter.sourceId, ok: false, errorCode: failure.code, fetched: 0, duplicatesInBatch: 0});
    }
  }

  return {observedAt: options.observedAt, sources, added, changed, decisions, reviews};
}
