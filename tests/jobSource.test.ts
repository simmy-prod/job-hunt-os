import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/errors.js";
import { APPROVED_JOB_SOURCE_HOSTS, fetchAllListings, readOnlyJobFetch } from "../src/jobSource.js";
import type { JobSourceAdapter } from "../src/jobSource.js";
import { discoveryFixturePages, fixtureAdapter } from "./helpers.js";

const approvedUrl = `https://${APPROVED_JOB_SOURCE_HOSTS[0]}/v1/boards/example/jobs`;

test("transport blocks unapproved hosts, mutations, credentials-in-URL, and fragments", async () => {
  let calls = 0;
  const transport = readOnlyJobFetch(async () => {
    calls++;
    return Response.json({});
  });
  for (const [url, init] of [
    ["https://jobs.example.org/1", {}],
    [approvedUrl, {method: "POST"}],
    [`https://user:pass@${APPROVED_JOB_SOURCE_HOSTS[0]}/v1`, {}],
    [`${approvedUrl}#fragment`, {}],
    [approvedUrl.replace("https://", "http://"), {}],
  ] as const) {
    await assert.rejects(transport(url, init), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "POLICY");
      return true;
    });
  }
  assert.equal(calls, 0);
});
test("transport allows an approved host with no redirects and a bounded timeout", async () => {
  const calls: RequestInit[] = [];
  const transport = readOnlyJobFetch(async (_url, init) => {
    calls.push(init);
    return Response.json({ok: true});
  });
  const response = await transport(approvedUrl, {});
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.redirect, "error");
  assert.ok(calls[0]?.signal instanceof AbortSignal);
});
test("bounded retry honors Retry-After and does not retry a non-transient failure", async () => {
  const delays: number[] = [];
  let calls = 0;
  const transport = readOnlyJobFetch(async () => {
    calls++;
    return calls === 1 ? new Response("retry", {status: 503, headers: {"retry-after": "2"}}) : Response.json({ok: true});
  }, async (ms) => { delays.push(ms); });
  assert.equal((await transport(approvedUrl, {})).status, 200);
  assert.deepEqual(delays, [2000]);
  calls = 0;
  const failing = readOnlyJobFetch(async () => { calls++; return new Response("nope", {status: 404}); });
  assert.equal((await failing(approvedUrl, {})).status, 404);
  assert.equal(calls, 1);
});

test("fetchAllListings walks every page in cursor order", async () => {
  const adapter = fixtureAdapter("example", discoveryFixturePages());
  const raw = await fetchAllListings(adapter);
  assert.equal(raw.length, 4);
  assert.deepEqual(
    raw.map((item) => (item as {externalId: string}).externalId),
    ["1001", "1001", "1002", "1003"],
  );
});
test("a non-advancing cursor fails without looping forever", async () => {
  const adapter: JobSourceAdapter = {
    sourceId: "example",
    fetchPage: async () => ({rawListings: [], nextCursor: "same"}),
  };
  await assert.rejects(fetchAllListings(adapter), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "SOURCE");
    assert.match(error.message, /did not advance/);
    return true;
  });
});
test("pagination exceeding the run budget fails closed", async () => {
  const adapter: JobSourceAdapter = {
    sourceId: "example",
    fetchPage: async (cursor) => ({rawListings: [], nextCursor: cursor === null ? "1" : String(Number(cursor) + 1)}),
  };
  await assert.rejects(fetchAllListings(adapter), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "SOURCE");
    assert.match(error.message, /exceeded the run budget/);
    return true;
  });
});
test("an unavailable source is reported as SOURCE without leaking the raw error", async () => {
  const adapter: JobSourceAdapter = {
    sourceId: "example",
    fetchPage: async () => { throw new Error("ECONNRESET secret-internal-detail"); },
  };
  await assert.rejects(fetchAllListings(adapter), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "SOURCE");
    assert.doesNotMatch(error.message, /secret-internal-detail/);
    return true;
  });
});
test("an adapter's own AppError passes through unchanged", async () => {
  const adapter: JobSourceAdapter = {
    sourceId: "example",
    fetchPage: async () => { throw new AppError("AUTH", "credential missing"); },
  };
  await assert.rejects(fetchAllListings(adapter), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "AUTH");
    return true;
  });
});
