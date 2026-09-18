import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotionReader, NotionSnapshotSource, readOnlyFetch, validateNotionSchema } from "../src/notion.js";
import { batch, metadata, notionConfig, page } from "./helpers.js";

test("schema drift is explicit and never repaired", () => {
  const schema = metadata();
  const { ["Check Frequency"]: _removed, ...properties } = schema.properties;
  assert.ok(_removed);
  assert.throws(() => validateNotionSchema({properties}, notionConfig), /Check Frequency: expected select, found missing/);
  assert.throws(() => validateNotionSchema({properties: {...properties, "Role Type": {type: "select"}}}, notionConfig), /Role Type/);
  validateNotionSchema({properties}, {...notionConfig, frequency: {mode: "fixed", value: "weekly"}});
});
test("snapshot reads all pages with stable IDs and preserves unset optional role", async () => {
  const cursors: Array<string | undefined> = [];
  const source = new NotionSnapshotSource(notionConfig, {
    retrieve: async () => metadata(),
    query: async (cursor) => {
      cursors.push(cursor);
      return cursor ? batch([page("33333333-3333-4333-8333-333333333333")])
        : {...batch([page()]), has_more: true, next_cursor: "second"};
    },
  });
  const result = await source.read();
  assert.deepEqual(cursors, [undefined, "second"]);
  assert.equal(result.targets.length, 2);
  assert.equal(result.targets[0]?.checkFrequency, "weekly");
  assert.equal(result.applications[0]?.role, null);
});
test("schema failure prevents even querying the rows", async () => {
  let queries = 0;
  const source = new NotionSnapshotSource(notionConfig, {retrieve: async () => ({properties: {}}), query: async () => {queries++; return batch([]);}});
  await assert.rejects(source.read(), /schema drift/);
  assert.equal(queries, 0);
});
test("failed second page never returns a partial snapshot or raw error", async () => {
  const source = new NotionSnapshotSource(notionConfig, {
    retrieve: async () => metadata(), query: async (cursor) => {
      if (cursor) throw new Error("SECRET_TOKEN private-person@example.org");
      return {...batch([page()]), has_more: true, next_cursor: "second"};
    },
  });
  await assert.rejects(source.read(), (error: Error) => {
    assert.match(error.message, /complete snapshot/); assert.doesNotMatch(error.message, /SECRET_TOKEN|private-person/); return true;
  });
});
test("partial rows, invalid values, duplicate IDs and incomplete queries fail closed", async () => {
  const invalid = page(); invalid.properties["Pipeline Stage"].select.name = "Appllied";
  const values = [batch([{object: "page", id: page().id}]), batch([invalid]), batch([page(), page()]),
    {...batch([page()]), request_status: {type: "incomplete"}}, {...batch([]), has_more: true, next_cursor: null}];
  for (const value of values) {
    const source = new NotionSnapshotSource(notionConfig, {retrieve: async () => metadata(), query: async () => value});
    await assert.rejects(source.read());
  }
});
test("repeated pagination cursor fails without looping", async () => {
  const source = new NotionSnapshotSource(notionConfig, {retrieve: async () => metadata(),
    query: async () => ({...batch([]), has_more: true, next_cursor: "same"})});
  await assert.rejects(source.read(), /pagination did not advance/);
});
test("archived rows are excluded and saved searches are classified", async () => {
  const saved = page(); saved.properties.Company.title[0]!.plain_text = "[Saved Search] Example";
  const source = new NotionSnapshotSource(notionConfig, {retrieve: async () => metadata(),
    query: async () => batch([{...page(), in_trash: true}, saved])});
  const result = await source.read();
  assert.equal(result.targets.length, 1); assert.equal(result.targets[0]?.kind, "saved_search");
});
test("date ranges and timestamps require an explicit migration policy", async () => {
  const raw = page();
  const ranged = {...raw, properties: {...raw.properties, "Next Action Date": {type: "date", date: {start: "2026-09-18", end: "2026-09-20"}}}};
  const source = new NotionSnapshotSource(notionConfig, {retrieve: async () => metadata(), query: async () => batch([ranged])});
  await assert.rejects(source.read(), /Next Action Date/);
});
test("actual SDK transport allows only the two read operations with the pinned version", async () => {
  const calls: Array<[string, RequestInit]> = [];
  const reader = createNotionReader(notionConfig, "synthetic-token", async (url, init) => {
    calls.push([url, init]);
    return Response.json(init.method === "GET" ? metadata() : batch([page()]));
  });
  await new NotionSnapshotSource(notionConfig, reader).read();
  assert.deepEqual(calls.map(([, init]) => init.method), ["GET", "POST"]);
  assert.ok(calls.every(([, init]) => init.redirect === "error"));
  assert.equal(new Headers(calls[0]?.[1].headers).get("notion-version"), "2026-03-11");
});
test("transport blocks mutations, other sources, other hosts and redirect settings", async () => {
  let calls = 0;
  const transport = readOnlyFetch(notionConfig.dataSourceId, async () => {calls++; return Response.json({});});
  for (const [url, method] of [
    ["https://api.notion.com/v1/pages", "POST"], ["https://jobs.example.org", "GET"],
    [`https://api.notion.com/v1/data_sources/${notionConfig.dataSourceId}`, "PATCH"],
    ["https://api.notion.com/v1/data_sources/33333333-3333-4333-8333-333333333333", "GET"],
  ]) await assert.rejects(transport(url!, {method: method!}), /blocked/);
  assert.equal(calls, 0);
});
test("bounded retry honors Retry-After and does not retry credentials errors", async () => {
  const delays: number[] = []; let calls = 0;
  const url = `https://api.notion.com/v1/data_sources/${notionConfig.dataSourceId}/query`;
  const transport = readOnlyFetch(notionConfig.dataSourceId, async () => {
    calls++; return calls === 1 ? new Response("retry", {status: 429, headers: {"retry-after": "1"}}) : Response.json({});
  }, async (ms) => {delays.push(ms);});
  assert.equal((await transport(url, {method: "POST"})).status, 200);
  assert.deepEqual(delays, [1000]);
  calls = 0;
  const failing = readOnlyFetch(notionConfig.dataSourceId, async () => {calls++; return new Response("unauthorized", {status: 401});});
  assert.equal((await failing(url, {method: "POST"})).status, 401); assert.equal(calls, 1);
});
test("missing token and provider authorization failures give safe diagnostics", async () => {
  assert.throws(() => createNotionReader(notionConfig, undefined), /NOTION_TOKEN/);
  const reader = createNotionReader(notionConfig, "synthetic-token", async () => Response.json({object: "error", status: 401,
    code: "unauthorized", message: "secret-provider-details"}, {status: 401}));
  await assert.rejects(new NotionSnapshotSource(notionConfig, reader).read(), /Notion access failed/);
});
