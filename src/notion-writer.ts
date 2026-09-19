import { Client, isNotionClientError } from "@notionhq/client";
import { z } from "zod";
import type { NotionConfig } from "./config.js";
import { validate } from "./domain.js";
import { AppError } from "./errors.js";
import { boundedFetch, NOTION_API_VERSION, readDate, readSelect, readText } from "./notion.js";
import type { Fetch, FetchInit, Wait } from "./notion.js";
import type { FieldValues, WritableField } from "./writes.js";

export const WRITE_TOKEN_ENV = "NOTION_WRITE_TOKEN";
const fieldTypes: Record<WritableField, "date" | "rich_text" | "select"> = {
  lastChecked: "date", nextAction: "rich_text", nextActionDate: "date", pipelineStage: "select", appliedDate: "date",
};

// Only fields the explicit mapping names can be written. Everything else in
// the Notion row (company, watch status, URLs, role types, ...) is unreachable.
export function writableProperties(config: NotionConfig): Map<WritableField, string> {
  const f = config.fields;
  const map = new Map<WritableField, string>([
    ["lastChecked", f.lastChecked], ["nextAction", f.nextAction], ["nextActionDate", f.nextActionDate], ["pipelineStage", f.pipelineStage],
  ]);
  if (f.appliedDate) map.set("appliedDate", f.appliedDate);
  return map;
}

const pagePath = /^\/v1\/pages\/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Three operations only: read the data source schema, read one page, and
// set mapped properties on one page. The PATCH body is inspected so no
// archive, trash, icon, cover, template, or unmapped property can pass.
export function writeFetch(dataSourceId: string, allowedProperties: ReadonlySet<string>, network?: Fetch, wait?: Wait) {
  const send = boundedFetch(network, wait);
  return async (input: string, init: FetchInit = {}): Promise<Response> => {
    const blocked = new AppError("POLICY", "The Notion write transport blocked an unsupported request.");
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    if (url.origin !== "https://api.notion.com" || url.username || url.password || url.search || url.hash) throw blocked;
    const isPage = pagePath.test(url.pathname);
    if (method === "GET" && (isPage || url.pathname === `/v1/data_sources/${dataSourceId}`)) {
      if (init.body !== undefined) throw blocked;
      return send(input, init);
    }
    if (method !== "PATCH" || !isPage || typeof init.body !== "string") throw blocked;
    let body: unknown;
    try { body = JSON.parse(init.body); } catch { throw blocked; }
    if (!isRecord(body) || Object.keys(body).join() !== "properties" || !isRecord(body.properties)) throw blocked;
    const entries = Object.entries(body.properties);
    if (!entries.length || entries.some(([name, value]) => !allowedProperties.has(name) || !isRecord(value) ||
      Object.keys(value).length !== 1 || !["date", "rich_text", "select"].includes(Object.keys(value)[0]!))) throw blocked;
    return send(input, init);
  };
}

export interface PageWriter {
  // Verifies property types and that any select value already exists.
  prepare(desired: FieldValues): Promise<void>;
  read(recordId: string, fields: readonly WritableField[]): Promise<FieldValues>;
  write(recordId: string, desired: FieldValues): Promise<FieldValues>;
}

const metadataSchema = z.object({
  properties: z.record(z.string(), z.object({type: z.string(), select: z.object({options: z.array(z.object({name: z.string()}))}).optional()})),
});
const pageSchema = z.object({
  object: z.literal("page"), id: z.uuid(),
  archived: z.boolean().optional(), in_trash: z.boolean().optional(),
  parent: z.object({type: z.string(), data_source_id: z.string().optional()}),
  properties: z.record(z.string(), z.unknown()),
});
const compactId = (value: string) => value.replaceAll("-", "").toLowerCase();

function propertyValue(type: "date" | "rich_text" | "select", value: string | null | undefined): Record<string, unknown> {
  if (typeof value !== "string") throw new AppError("POLICY", "Writes never clear a field.");
  if (type === "date") return {date: {start: value}};
  if (type === "rich_text") return {rich_text: [{type: "text", text: {content: value}}]};
  return {select: {name: value}};
}

export function createNotionWriter(config: NotionConfig, tokens: {write: string | undefined; read: ReadonlyArray<string | undefined>},
  network?: Fetch, wait?: Wait): PageWriter {
  const token = tokens.write?.trim();
  if (!token) throw new AppError("AUTH", `Set ${WRITE_TOKEN_ENV} for a dedicated Notion write integration (read and update content only), shared with the target data source. Never paste the token into chat or commit it.`);
  if (tokens.read.some((read) => read?.trim() === token)) {
    throw new AppError("AUTH", `${WRITE_TOKEN_ENV} must belong to a separate write integration, not a read-only token (NOTION_TOKEN or the Keychain item).`);
  }
  const properties = writableProperties(config);
  const transport = writeFetch(config.dataSourceId, new Set(properties.values()), network, wait);
  const client = new Client({
    auth: token, notionVersion: NOTION_API_VERSION, timeoutMs: 60_000, retry: false, logger: () => {},
    fetch: async (url, init) => {
      const response = await transport(url, init);
      return {ok: response.ok, status: response.status, headers: response.headers, text: () => response.text()};
    },
  });
  const name = (field: WritableField) => {
    const mapped = properties.get(field);
    if (!mapped) throw new AppError("CONFIG", "The Notion mapping has no property for a field this write needs.");
    return mapped;
  };
  function parse(raw: unknown, fields: readonly WritableField[]): FieldValues {
    const page = validate(pageSchema, raw, "Notion page");
    if (page.parent.type !== "data_source_id" || compactId(page.parent.data_source_id ?? "") !== compactId(config.dataSourceId)) {
      throw new AppError("POLICY", "The page is not in the configured data source. Nothing was written.");
    }
    if (page.archived || page.in_trash) throw new AppError("POLICY", "The page is archived or in the trash. Nothing was written.");
    return Object.fromEntries(fields.map((field) => {
      const type = fieldTypes[field];
      const value = type === "date" ? readDate(page.properties, name(field))
        : type === "rich_text" ? readText(page.properties, name(field)) : readSelect(page.properties, name(field));
      // Same normalization as the reader, so comparisons use domain values.
      return [field, field === "pipelineStage" && value?.trim().toLowerCase() === "not a fit" ? "Closed" : value];
    }));
  }
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) {
      if (error instanceof AppError) throw error;
      if (isNotionClientError(error) && ["unauthorized", "restricted_resource", "object_not_found"].includes(error.code)) {
        throw new AppError("AUTH", `Notion write access failed. Verify ${WRITE_TOKEN_ENV} and that its connection is shared with the data source.`);
      }
      if (isNotionClientError(error) && error.code === "validation_error") {
        throw new AppError("SCHEMA", "Notion rejected the write as invalid. Check the field mapping in docs/runtime.md.");
      }
      throw new AppError("NOTION", "Notion did not complete the request. The outcome is re-checked by read-back on the next apply.");
    }
  };
  let schema: z.infer<typeof metadataSchema> | undefined;
  return {
    prepare: (desired) => guard(async () => {
      schema ??= validate(metadataSchema, await client.dataSources.retrieve({data_source_id: config.dataSourceId}), "Notion data source");
      for (const [field, value] of Object.entries(desired) as Array<[WritableField, string | null]>) {
        const property = schema.properties[name(field)];
        if (property?.type !== fieldTypes[field]) throw new AppError("SCHEMA", `Notion schema drift on a writable field (${field}). Nothing was written.`);
        if (fieldTypes[field] === "select" && !property.select?.options.some((option) => option.name === value)) {
          throw new AppError("SCHEMA", `The ${field} value is not an existing Notion option. Writes never create select options.`);
        }
      }
    }),
    read: (recordId, fields) => guard(async () => parse(await client.pages.retrieve({page_id: recordId}), fields)),
    write: (recordId, desired) => guard(async () => {
      const fields = Object.keys(desired) as WritableField[];
      const body = Object.fromEntries(fields.map((field) => [name(field), propertyValue(fieldTypes[field], desired[field])]));
      return parse(await client.pages.update({page_id: recordId, properties: body as never}), fields);
    }),
  };
}
