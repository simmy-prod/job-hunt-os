import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotionWriter, writableProperties, writeFetch } from "../src/notion-writer.js";
import { metadata, notionConfig, page } from "./helpers.js";

const pageId = "22222222-2222-4222-8222-222222222222";
const pages = "https://api.notion.com/v1/pages";
const allowed = new Set(writableProperties(notionConfig).values());
const token = "synthetic-write-token";

function schema() {
  const base = metadata();
  return {properties: {...base.properties,
    "Pipeline Stage": {type: "select", select: {options: ["Researching", "Applied", "Screen"].map((name) => ({name}))}}}};
}
function row(overrides: Record<string, unknown> = {}) {
  return {...page(pageId), parent: {type: "data_source_id", data_source_id: notionConfig.dataSourceId,
    database_id: "44444444-4444-4444-8444-444444444444"}, ...overrides};
}
function network(options: {page?: unknown; schema?: unknown; status?: number} = {}) {
  const calls: Array<{url: string; method: string; body: unknown; headers: Headers; redirect: unknown}> = [];
  let current = options.page ?? row();
  const fetch = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) as {properties: Record<string, unknown>} : undefined;
    calls.push({url, method, body, headers: new Headers(init.headers), redirect: init.redirect});
    if (options.status) return Response.json({object: "error", status: options.status, code: "unauthorized", message: `secret ${token}`}, {status: options.status});
    if (url.includes("/data_sources/")) return Response.json(options.schema ?? schema());
    if (method === "PATCH") {
      const existing = current as ReturnType<typeof row>;
      current = {...existing, properties: {...existing.properties, "Pipeline Stage": {type: "select", select: {name: "Screen"}}}};
    }
    return Response.json(current);
  };
  return {calls, fetch};
}

test("write transport blocks creates, archives, content, comments, unmapped fields, and other hosts", async () => {
  let sent = 0;
  const transport = writeFetch(notionConfig.dataSourceId, allowed, async () => { sent++; return Response.json({}); });
  const patch = (body: unknown) => ({method: "PATCH", body: JSON.stringify(body)});
  const stage = {"Pipeline Stage": {select: {name: "Screen"}}};
  for (const [url, init] of [
    [pages, {method: "POST", body: JSON.stringify({properties: stage})}],
    [`${pages}/${pageId}`, patch({archived: true})],
    [`${pages}/${pageId}`, patch({in_trash: true})],
    [`${pages}/${pageId}`, patch({properties: stage, icon: {emoji: "x"}})],
    [`${pages}/${pageId}`, patch({properties: {Company: {title: [{text: {content: "Renamed"}}]}}})],
    [`${pages}/${pageId}`, patch({properties: {"Watch Status": {select: {name: "Paused"}}}})],
    [`${pages}/${pageId}`, patch({properties: {"Pipeline Stage": {select: {name: "Screen"}, status: {name: "x"}}}})],
    [`${pages}/${pageId}`, patch({properties: {}})],
    [`${pages}/${pageId}`, {method: "PATCH", body: "not json"}],
    [`${pages}/${pageId}`, {method: "DELETE"}],
    [`${pages}/${pageId}?filter_properties=x`, {method: "GET"}],
    [`https://api.notion.com/v1/blocks/${pageId}/children`, patch({children: []})],
    ["https://api.notion.com/v1/comments", {method: "POST", body: "{}"}],
    [`https://api.notion.com/v1/data_sources/${notionConfig.dataSourceId}`, patch({properties: {}})],
    [`https://api.notion.com/v1/data_sources/${notionConfig.dataSourceId}/query`, {method: "POST"}],
    ["https://api.notion.com/v1/data_sources/33333333-3333-4333-8333-333333333333", {method: "GET"}],
    [`https://jobs.example.org/v1/pages/${pageId}`, patch({properties: stage})],
  ] as Array<[string, {method: string; body?: string}]>) {
    await assert.rejects(transport(url, init), /write transport blocked/, `${init.method} ${url}`);
  }
  assert.equal(sent, 0);
  await transport(`${pages}/${pageId}`, {method: "GET"});
  await transport(`${pages}/${pageId}`, patch({properties: stage}));
  assert.equal(sent, 2);
});

test("SDK writer reads schema and page, then sends one mapped PATCH with the pinned version", async () => {
  const net = network();
  const writer = createNotionWriter(notionConfig, {write: token, read: ["synthetic-read-token"]}, net.fetch);
  await writer.prepare({pipelineStage: "Screen"});
  assert.deepEqual(await writer.read(pageId, ["pipelineStage", "nextActionDate"]), {pipelineStage: "Researching", nextActionDate: "2026-09-18"});
  assert.deepEqual(await writer.write(pageId, {pipelineStage: "Screen"}), {pipelineStage: "Screen"});
  assert.deepEqual(net.calls.map((call) => call.method), ["GET", "GET", "PATCH"]);
  assert.deepEqual(net.calls[2]?.body, {properties: {"Pipeline Stage": {select: {name: "Screen"}}}});
  assert.ok(net.calls.every((call) => call.redirect === "error" && call.headers.get("notion-version") === "2026-03-11" &&
    call.headers.get("authorization") === `Bearer ${token}`));
});

test("text and date writes use exact Notion payloads", async () => {
  const net = network();
  const writer = createNotionWriter(notionConfig, {write: token, read: []}, net.fetch);
  await writer.write(pageId, {nextAction: "Prepare questions", nextActionDate: "2026-09-22"}).catch(() => {});
  assert.deepEqual(net.calls[0]?.body, {properties: {
    "Next Action": {rich_text: [{type: "text", text: {content: "Prepare questions"}}]},
    "Next Action Date": {date: {start: "2026-09-22"}},
  }});
});

test("pages outside the data source, trashed pages, and new select options are refused", async () => {
  const foreign = network({page: row({parent: {type: "data_source_id", data_source_id: "33333333-3333-4333-8333-333333333333"}})});
  await assert.rejects(createNotionWriter(notionConfig, {write: token, read: []}, foreign.fetch).read(pageId, ["pipelineStage"]), /not in the configured data source/);
  const trashed = network({page: row({in_trash: true})});
  await assert.rejects(createNotionWriter(notionConfig, {write: token, read: []}, trashed.fetch).read(pageId, ["pipelineStage"]), /trash/);
  const net = network();
  const writer = createNotionWriter(notionConfig, {write: token, read: []}, net.fetch);
  await assert.rejects(writer.prepare({pipelineStage: "Offer"}), /never create select options/);
  await assert.rejects(writer.write("target-northwind", {lastChecked: "2026-09-18"}), (error: Error & {code?: string}) =>
    error.code === "POLICY" && /write transport blocked/.test(error.message));
  const drifted = network({schema: {properties: {...schema().properties, "Last Checked": {type: "rich_text"}}}});
  await assert.rejects(createNotionWriter(notionConfig, {write: token, read: []}, drifted.fetch).prepare({lastChecked: "2026-09-18"}), /schema drift/);
  assert.ok([...foreign.calls, ...trashed.calls, ...net.calls, ...drifted.calls].every((call) => call.method === "GET"));
});

test("write credentials are separate, required, and never echoed", async () => {
  assert.throws(() => createNotionWriter(notionConfig, {write: undefined, read: ["read"]}), /NOTION_WRITE_TOKEN/);
  assert.throws(() => createNotionWriter(notionConfig, {write: " ", read: ["read"]}), /NOTION_WRITE_TOKEN/);
  assert.throws(() => createNotionWriter(notionConfig, {write: token, read: [token]}), /separate write integration/);
  // Also refused when it matches the Keychain read token used by scheduled runs.
  assert.throws(() => createNotionWriter(notionConfig, {write: token, read: [undefined, token]}), /separate write integration/);
  const denied = network({status: 401});
  await assert.rejects(createNotionWriter(notionConfig, {write: token, read: []}, denied.fetch).read(pageId, ["lastChecked"]),
    (error: Error) => { assert.match(error.message, /write access failed/); assert.doesNotMatch(error.message, new RegExp(token)); return true; });
});

test("an unmapped optional field is not writable", () => {
  assert.equal(writableProperties(notionConfig).has("appliedDate"), false);
  const mapped = writableProperties({...notionConfig, fields: {...notionConfig.fields, appliedDate: "Applied Date"}});
  assert.equal(mapped.get("appliedDate"), "Applied Date");
  assert.deepEqual([...writableProperties(notionConfig).values()].sort(), ["Last Checked", "Next Action", "Next Action Date", "Pipeline Stage"]);
});
