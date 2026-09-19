import { createHash } from "node:crypto";
import { z } from "zod";
import type { DiscoveryReview, Listing, MatchDecision } from "./domain.js";
import { identifier, text, webUrl } from "./domain.js";
import type { MatchingConfig } from "./matchingConfig.js";

// Deliberately loose and fully optional: a raw provider payload is untrusted
// input from outside the process. It must be classified as a review item,
// never thrown, when it does not fit; unrecognized keys are dropped, not
// rejected, since a future adapter's raw shape will carry provider-specific
// fields this layer does not need.
const rawListingShape = z.object({
  externalId: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
  company: z.string().optional(),
  url: z.string().optional(),
  locations: z.array(z.string()).optional(),
});

export type NormalizedListing = Omit<Listing, "firstSeenAt" | "lastSeenAt">;

export type NormalizationResult =
  | {outcome: "listing"; listing: NormalizedListing}
  | {outcome: "review"; review: DiscoveryReview};

// Hashes only the fields a human would notice changed. sourceId/externalId
// are excluded: they never change without changing identity itself.
export function contentHashOf(listing: Pick<NormalizedListing, "title" | "company" | "canonicalUrl" | "locations">): string {
  return createHash("sha256").update(JSON.stringify({
    title: listing.title, company: listing.company, canonicalUrl: listing.canonicalUrl, locations: [...listing.locations].sort(),
  })).digest("hex");
}

// Structural validation only (is this a usable listing at all). Role-fit
// judgment (does it match the search) is evaluateMatch's job, kept separate
// so a listing can be persisted and re-judged later without re-fetching it.
export function normalizeListing(raw: unknown, sourceId: string, observedAt: string): NormalizationResult {
  const review = (externalId: string | null, reason: string): NormalizationResult => ({outcome: "review", review: {sourceId, externalId, reason, observedAt}});

  const parsed = rawListingShape.safeParse(raw);
  if (!parsed.success) return review(null, "Raw listing payload did not match the expected shape.");
  const data = parsed.data;

  const externalId = data.externalId === undefined ? "" : String(data.externalId).trim();
  if (!externalId) return review(null, "Listing is missing a stable external ID.");
  if (!identifier.safeParse(externalId).success) return review(externalId, "External ID contains characters outside the safe identifier set.");

  const title = text.safeParse(data.title);
  if (!title.success) return review(externalId, "Listing is missing a title.");
  const company = text.safeParse(data.company);
  if (!company.success) return review(externalId, "Listing is missing a company name.");
  const url = webUrl.safeParse(data.url);
  if (!url.success) return review(externalId, "Listing has a missing or invalid URL.");
  const locations = (data.locations ?? []).map((location) => location.trim()).filter(Boolean);
  if (locations.length === 0) return review(externalId, "Listing has no location information.");

  const listing: NormalizedListing = {
    id: `${sourceId}:${externalId}`, sourceId, externalId, title: title.data, company: company.data,
    canonicalUrl: url.data, locations,
    contentHash: contentHashOf({title: title.data, company: company.data, canonicalUrl: url.data, locations}),
  };
  return {outcome: "listing", listing};
}

export interface NormalizeBatchResult {
  listings: NormalizedListing[];
  reviews: DiscoveryReview[];
  duplicatesInBatch: number;
}

// Collapses repeated externalIds within one fetch (a paginated source
// returning overlapping rows, or a malformed feed) into one listing per
// stable identity, deterministically: the last occurrence in fetch order
// wins, and the count of collisions is reported rather than silently lost.
export function normalizeBatch(rawListings: readonly unknown[], sourceId: string, observedAt: string): NormalizeBatchResult {
  const byId = new Map<string, NormalizedListing>();
  const reviews: DiscoveryReview[] = [];
  let duplicatesInBatch = 0;
  for (const raw of rawListings) {
    const result = normalizeListing(raw, sourceId, observedAt);
    if (result.outcome === "review") {
      reviews.push(result.review);
      continue;
    }
    if (byId.has(result.listing.id)) duplicatesInBatch++;
    byId.set(result.listing.id, result.listing);
  }
  const byIdAscending = (a: NormalizedListing, b: NormalizedListing) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {listings: [...byId.values()].sort(byIdAscending), reviews, duplicatesInBatch};
}

// Ambiguous title matches become "needs_review", never a guessed match, per
// the search's non-coding scope (see CLAUDE.md). Exclusion is checked first:
// a title naming both an included and an excluded keyword is not a match.
export function evaluateMatch(listing: NormalizedListing, config: MatchingConfig): MatchDecision {
  const titleLower = listing.title.toLowerCase();
  const excluded = config.titleExcludeKeywords.find((keyword) => titleLower.includes(keyword.toLowerCase()));
  if (excluded) {
    return {listingId: listing.id, ruleVersion: config.ruleVersion, decision: "not_a_match", reasons: [`Title contains excluded keyword "${excluded}".`]};
  }
  const included = config.titleIncludeKeywords.filter((keyword) => titleLower.includes(keyword.toLowerCase()));
  if (included.length > 0) {
    return {listingId: listing.id, ruleVersion: config.ruleVersion, decision: "match", reasons: included.map((keyword) => `Title contains included keyword "${keyword}".`)};
  }
  return {listingId: listing.id, ruleVersion: config.ruleVersion, decision: "needs_review", reasons: ["Title does not contain a recognized included keyword."]};
}
