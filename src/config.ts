import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import { frequency, text, validate } from "./domain.js";
import { AppError } from "./errors.js";

const propertyName = text;
export const notionConfigSchema = z.strictObject({
  driver: z.literal("notion"),
  dataSourceId: z.uuid(),
  tokenEnv: z.literal("NOTION_TOKEN"),
  fields: z.strictObject({
    company: propertyName,
    watchStatus: propertyName,
    careersUrl: propertyName,
    roleTypes: propertyName,
    roleTypesType: z.enum(["select", "multi_select"]),
    lastChecked: propertyName,
    pipelineStage: propertyName,
    nextAction: propertyName,
    nextActionDate: propertyName,
    role: propertyName.nullable(),
    appliedDate: propertyName.nullable(),
    sourceUrl: propertyName.nullable(),
  }),
  frequency: z.discriminatedUnion("mode", [
    z.strictObject({mode: z.literal("property"), property: propertyName, emptyDefault: frequency}),
    z.strictObject({mode: z.literal("fixed"), value: frequency}),
  ]),
});

export const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  timezone: z.string().refine((value) => {
    try { new Intl.DateTimeFormat("en", {timeZone: value}); return true; } catch { return false; }
  }, "Expected an IANA timezone"),
  source: z.discriminatedUnion("driver", [
    z.strictObject({driver: z.literal("snapshot"), path: text}),
    notionConfigSchema,
  ]),
  // Optional and absent by default: a config without it never runs unattended.
  schedule: z.strictObject({
    enabled: z.boolean(),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM in 24-hour time"),
  }).optional(),
});
export type Config = z.infer<typeof configSchema>;
export type NotionConfig = z.infer<typeof notionConfigSchema>;

export async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch { throw new AppError("CONFIG", "Cannot read a valid JSON input. Check the configured file exists and contains JSON."); }
}

export async function loadConfig(path: string): Promise<Config> {
  const config = validate(configSchema, await readJson(path), "Configuration");
  if (config.source.driver === "snapshot") {
    config.source.path = resolve(dirname(path), config.source.path);
  }
  return config;
}

// The fields that change what a plan means. Scheduling settings are excluded so
// that editing the schedule never forks a day's logical run key.
export function planningConfig(config: Config): Pick<Config, "schemaVersion" | "timezone" | "source"> {
  return {schemaVersion: config.schemaVersion, timezone: config.timezone, source: config.source};
}
