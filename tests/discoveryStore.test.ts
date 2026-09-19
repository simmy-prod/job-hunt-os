import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../src/errors.js";
import { DiscoveryStore } from "../src/discoveryStore.js";
import type { NormalizedListing } from "../src/normalize.js";

const temporary = () => mkdtempSync(join(tmpdir(), "job-hunt-discovery-"));
const listing = (overrides: Partial<NormalizedListing> = {}): NormalizedListing => ({
  id: "example:1001", sourceId: "example", externalId: "1001", title: "Business Analyst",
  company: "Northwind Example", canonicalUrl: "https://jobs.example.org/northwind/1001",
  locations: ["Melbourne, AU"], employmentType: "Full-time", compensationText: null,
  contentHash: "a".repeat(64), ...overrides,
});

test("a newly seen listing is added with matching first/last-seen timestamps", () => {
  const store = new DiscoveryStore(temporary());
  try {
    const summary = store.mergeListings([listing()], "2026-09-18T00:00:00.000Z");
    assert.deepEqual(summary, {added: ["example:1001"], changed: [], unchanged: []});
    const [stored] = store.listListings();
    assert.equal(stored?.firstSeenAt, "2026-09-18T00:00:00.000Z");
    assert.equal(stored?.lastSeenAt, "2026-09-18T00:00:00.000Z");
  } finally { store.close(); }
});
test("re-merging identical content reports unchanged and keeps first_seen_at fixed", () => {
  const store = new DiscoveryStore(temporary());
  try {
    store.mergeListings([listing()], "2026-09-18T00:00:00.000Z");
    const summary = store.mergeListings([listing()], "2026-09-19T00:00:00.000Z");
    assert.deepEqual(summary, {added: [], changed: [], unchanged: ["example:1001"]});
    const [stored] = store.listListings();
    assert.equal(stored?.firstSeenAt, "2026-09-18T00:00:00.000Z");
    assert.equal(stored?.lastSeenAt, "2026-09-19T00:00:00.000Z");
  } finally { store.close(); }
});
test("changed content updates the same listing identity instead of creating a duplicate", () => {
  const store = new DiscoveryStore(temporary());
  try {
    store.mergeListings([listing()], "2026-09-18T00:00:00.000Z");
    const summary = store.mergeListings([listing({title: "Business Analyst II", contentHash: "b".repeat(64)})], "2026-09-19T00:00:00.000Z");
    assert.deepEqual(summary, {added: [], changed: ["example:1001"], unchanged: []});
    const stored = store.listListings();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.title, "Business Analyst II");
    assert.equal(stored[0]?.firstSeenAt, "2026-09-18T00:00:00.000Z");
    assert.equal(stored[0]?.lastSeenAt, "2026-09-19T00:00:00.000Z");
  } finally { store.close(); }
});
test("a listing absent from a later merge (its source went unavailable) is left untouched, never deleted", () => {
  const store = new DiscoveryStore(temporary());
  try {
    store.mergeListings([listing()], "2026-09-18T00:00:00.000Z");
    store.mergeListings([], "2026-09-19T00:00:00.000Z");
    const stored = store.listListings();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.id, "example:1001");
  } finally { store.close(); }
});
test("identifiable reviews upsert into a queue keyed by source and external ID", () => {
  const store = new DiscoveryStore(temporary());
  try {
    store.upsertReviews([{sourceId: "example", externalId: "1002", reason: "Listing is missing a title.", observedAt: "2026-09-18T00:00:00.000Z"}]);
    store.upsertReviews([{sourceId: "example", externalId: "1002", reason: "Listing is missing a title.", observedAt: "2026-09-19T00:00:00.000Z"}]);
    const reviews = store.listReviews();
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.firstObservedAt, "2026-09-18T00:00:00.000Z");
    assert.equal(reviews[0]?.lastObservedAt, "2026-09-19T00:00:00.000Z");
  } finally { store.close(); }
});
test("a review without a usable external ID is never persisted", () => {
  const store = new DiscoveryStore(temporary());
  try {
    store.upsertReviews([{sourceId: "example", externalId: null, reason: "Raw listing payload did not match the expected shape.", observedAt: "2026-09-18T00:00:00.000Z"}]);
    assert.deepEqual(store.listReviews(), []);
  } finally { store.close(); }
});
test("a listing that later normalizes cleanly is removed from the open review queue", () => {
  const store = new DiscoveryStore(temporary());
  try {
    store.upsertReviews([{sourceId: "example", externalId: "1001", reason: "Listing is missing a title.", observedAt: "2026-09-18T00:00:00.000Z"}]);
    store.mergeListings([listing()], "2026-09-19T00:00:00.000Z");
    assert.deepEqual(store.listReviews(), []);
  } finally { store.close(); }
});
test("refuses a symlinked .runtime directory", () => {
  const root = temporary();
  const outside = temporary();
  symlinkSync(outside, join(root, ".runtime"));
  assert.throws(() => new DiscoveryStore(root), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "STORAGE");
    return true;
  });
});
