import { Client, isNotionClientError } from "@notionhq/client";
import { z } from "zod";
import type { NotionConfig } from "./config.js";
import { snapshotSchema, validate } from "./domain.js";
import type { Snapshot } from "./domain.js";
import { AppError } from "./errors.js";
import type { SnapshotSource } from "./source.js";

export const NOTION_API_VERSION = "2026-03-11";
const metadataSchema = z.object({
  properties: z.record(z.string(), z.object({type: z.string()})),
});
const pageSchema = z.object({
  object: z.literal("page"), id: z.uuid(),
  archived: z.boolean().optional(), in_trash: z.boolean().optional(),
  properties: z.record(z.string(), z.unknown()),
});
const querySchema = z.object({
  results: z.array(z.unknown()), has_more: z.boolean(), next_cursor: z.string().nullable(),
  request_status: z.object({type: z.string()}).optional(),
});

export type FetchInit = {method?: string; headers?: Record<string, string>; body?: string | FormData};
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type Wait = (milliseconds: number) => Promise<void>;

// Bounded retry shared by the read and write transports. Writes are property
// sets, so resending one after a transient failure cannot duplicate anything.
export function boundedFetch(network: Fetch = fetch,
  wait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  return async (input: string, init: FetchInit): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      const response = await network(input, {...init, redirect: "error", signal: AbortSignal.timeout(15_000)});
      if (![429, 500, 502, 503, 504, 529].includes(response.status) || attempt >= 2) return response;
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const delay = retryAfter === null ? 500 * 2 ** attempt
        : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
      // Do not retry sooner than requested when the provider exceeds our run budget.
      if (!Number.isFinite(delay) || delay > 20_000) return response;
      await response.body?.cancel();
      await wait(Math.max(0, delay));
    }
  };
}

// Both allowed operations are reads, although Notion uses POST for queries.
// No other host, data source, path, method, or redirect can receive the token.
export function readOnlyFetch(dataSourceId: string, network: Fetch = fetch,
  wait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const send = boundedFetch(network, wait);
  return async (input: string, init: FetchInit = {}): Promise<Response> => {
    const url = new URL(input);
    const base = `/v1/data_sources/${dataSourceId}`;
    const method = (init.method ?? "GET").toUpperCase();
    if (url.origin !== "https://api.notion.com" || url.username || url.password || url.search || url.hash ||
      !((url.pathname === base && method === "GET") || (url.pathname === `${base}/query` && method === "POST"))) {
      throw new AppError("POLICY", "The read-only Notion transport blocked an unsupported request.");
    }
    return send(input, init);
  };
}

export interface NotionReader {
  retrieve(): Promise<unknown>;
  query(cursor?: string): Promise<unknown>;
}

export function createNotionReader(config: NotionConfig, token: string | undefined, network?: Fetch): NotionReader {
  if (!token?.trim()) throw new AppError("AUTH", "Set NOTION_TOKEN for a dedicated Notion connection with read-content access, and share the data source with it. Never paste the token into chat or commit it.");
  const client = new Client({
    auth: token, notionVersion: NOTION_API_VERSION, timeoutMs: 60_000,
    retry: false, logger: () => {},
    fetch: async (url, init) => {
      const response = await readOnlyFetch(config.dataSourceId, network)(url, init);
      return {ok: response.ok, status: response.status, headers: response.headers, text: () => response.text()};
    },
  });
  return {
    retrieve: () => client.dataSources.retrieve({data_source_id: config.dataSourceId}),
    query: (cursor) => client.dataSources.query({data_source_id: config.dataSourceId, page_size: 100,
      ...(cursor === undefined ? {} : {start_cursor: cursor})}),
  };
}

export function requiredProperties(config: NotionConfig): Array<[string, string]> {
  const f = config.fields;
  const entries: Array<[string, string]> = [
    [f.company, "title"], [f.watchStatus, "select"], [f.careersUrl, "url"],
    [f.roleTypes, f.roleTypesType], [f.lastChecked, "date"], [f.pipelineStage, "select"],
    [f.nextAction, "rich_text"], [f.nextActionDate, "date"],
  ];
  if (f.role) entries.push([f.role, "rich_text"]);
  if (f.appliedDate) entries.push([f.appliedDate, "date"]);
  if (f.sourceUrl) entries.push([f.sourceUrl, "url"]);
  if (config.frequency.mode === "property") entries.push([config.frequency.property, "select"]);
  return entries;
}

export function validateNotionSchema(raw: unknown, config: NotionConfig): void {
  const schema = validate(metadataSchema, raw, "Notion data source");
  const issues = requiredProperties(config).flatMap(([name, type]) =>
    schema.properties[name]?.type === type ? [] : [`${name}: expected ${type}, found ${schema.properties[name]?.type ?? "missing"}`]);
  if (issues.length) throw new AppError("SCHEMA", `Notion schema drift. ${issues.join("; ")}. Update the explicit field mapping or review the migration in docs/runtime.md. No schema changes were made.`);
}

export function property(properties: Record<string, unknown>, name: string, type: string): unknown {
  const schema = z.object({type: z.literal(type), [type]: z.unknown()});
  const value = validate(schema, properties[name], `Notion property ${name}`);
  if (!(type in value)) throw new AppError("SCHEMA", `Notion property ${name} has no value payload.`);
  return value[type];
}
const richTextSchema = z.array(z.object({plain_text: z.string()}));
export function readText(properties: Record<string, unknown>, name: string, type = "rich_text"): string | null {
  return validate(richTextSchema, property(properties, name, type), `Notion property ${name}`)
    .map((item) => item.plain_text).join("").trim() || null;
}
export function readSelect(properties: Record<string, unknown>, name: string): string | null {
  return validate(z.object({name: z.string()}).nullable(), property(properties, name, "select"), `Notion property ${name}`)?.name ?? null;
}
export function readDate(properties: Record<string, unknown>, name: string): string | null {
  // A datetime/range needs an explicit policy. Do not silently discard its time/end.
  return validate(z.object({start: z.iso.date(), end: z.null().optional()}).nullable(),
    property(properties, name, "date"), `Notion property ${name}`)?.start ?? null;
}
function readUrl(properties: Record<string, unknown>, name: string): unknown {
  return property(properties, name, "url");
}

export class NotionSnapshotSource implements SnapshotSource {
  constructor(private readonly config: NotionConfig, private readonly reader: NotionReader) {}

  async read(): Promise<Snapshot> {
    try {
      validateNotionSchema(await this.reader.retrieve(), this.config);
      const targets: unknown[] = [];
      const applications: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const batch = validate(querySchema, await this.reader.query(cursor), "Notion query");
        if (batch.request_status && batch.request_status.type !== "complete") {
          throw new AppError("NOTION", "Notion returned an incomplete query. Narrow the data source before planning.");
        }
        for (const raw of batch.results) {
          const page = validate(pageSchema, raw, "Notion row");
          if (page.archived || page.in_trash) continue;
          const p = page.properties;
          const f = this.config.fields;
          const company = readText(p, f.company, "title");
          const roles = f.roleTypesType === "select" ? [readSelect(p, f.roleTypes)].filter(Boolean)
            : validate(z.array(z.object({name: z.string()})), property(p, f.roleTypes, "multi_select"), "Role Type").map((role) => role.name);
          targets.push({
            id: page.id, company,
            kind: company?.startsWith("[Saved Search]") ? "saved_search" : "company",
            watchStatus: readSelect(p, f.watchStatus), careersUrl: readUrl(p, f.careersUrl), roleTypes: roles,
            checkFrequency: this.config.frequency.mode === "fixed" ? this.config.frequency.value
              : readSelect(p, this.config.frequency.property) ?? this.config.frequency.emptyDefault,
            lastChecked: readDate(p, f.lastChecked),
          });
          const rawStage = readSelect(p, f.pipelineStage);
          const nextAction = readText(p, f.nextAction);
          const nextActionDate = readDate(p, f.nextActionDate);
          // A combined target/application table may have targets without a stage.
          // Actions without a stage are invalid, not silently lost.
          if (rawStage || nextAction || nextActionDate) applications.push({
            id: page.id, company,
            role: f.role ? readText(p, f.role) : null,
            stage: rawStage?.trim().toLowerCase() === "not a fit" ? "Closed" : rawStage,
            appliedDate: f.appliedDate ? readDate(p, f.appliedDate) : null,
            sourceUrl: f.sourceUrl ? readUrl(p, f.sourceUrl) : null,
            nextAction, nextActionDate,
          });
        }
        if (!batch.has_more) return validate(snapshotSchema, {schemaVersion: 1, targets, applications}, "Notion snapshot");
        if (!batch.next_cursor || cursors.has(batch.next_cursor)) throw new AppError("NOTION", "Notion pagination did not advance. No partial plan was produced.");
        cursors.add(batch.next_cursor);
        cursor = batch.next_cursor;
      }
      throw new AppError("NOTION", "Notion pagination exceeded the run budget. No partial plan was produced.");
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isNotionClientError(error) && ["unauthorized", "restricted_resource", "object_not_found"].includes(error.code)) {
        throw new AppError("AUTH", "Notion access failed. Verify NOTION_TOKEN, the data source ID, and connection sharing permissions.");
      }
      throw new AppError("NOTION", "Notion could not provide a complete snapshot. Retry later and check network access. No stale or partial plan was used.");
    }
  }
}
