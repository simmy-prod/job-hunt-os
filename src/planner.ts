import { createHash } from "node:crypto";
import type { Application, Snapshot, Target } from "./domain.js";
import { snapshotSchema, validate } from "./domain.js";
import { AppError } from "./errors.js";

export interface Review {
  kind: "target" | "application";
  id: string;
  reason: "missing_careers_url" | "future_last_checked" | "missing_action_date" | "missing_action";
}
export interface Plan {
  schemaVersion: 1;
  mode: "read_only";
  date: string;
  timezone: string;
  dueTargets: Array<Target & {reason: "never_checked" | "daily" | "weekly_over_7_days"}>;
  followUps: Array<Application & {overdueDays: number}>;
  reviews: Review[];
  counts: {targets: number; applications: number; dueTargets: number; followUps: number; reviews: number};
}

export function businessDate(now: Date, timezone: string): string {
  if (Number.isNaN(now.getTime())) throw new AppError("CONFIG", "Clock must be a valid timestamp.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function daysBetween(earlier: string, later: string): number {
  return (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000;
}
const byId = (a: {id: string}, b: {id: string}) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function planMorning(input: Snapshot, now: Date, timezone: string): Plan {
  const snapshot = validate(snapshotSchema, input, "Snapshot");
  const date = businessDate(now, timezone);
  const dueTargets: Plan["dueTargets"] = [];
  const followUps: Plan["followUps"] = [];
  const reviews: Review[] = [];
  for (const target of [...snapshot.targets].sort(byId)) {
    if (target.watchStatus !== "Active watch") continue;
    if (!target.careersUrl) {
      reviews.push({kind: "target", id: target.id, reason: "missing_careers_url"});
      continue;
    }
    if (target.lastChecked && target.lastChecked > date) {
      reviews.push({kind: "target", id: target.id, reason: "future_last_checked"});
      continue;
    }
    if (target.lastChecked === date) continue;
    if (!target.lastChecked) dueTargets.push({...target, reason: "never_checked"});
    else if (target.checkFrequency === "daily") dueTargets.push({...target, reason: "daily"});
    // Preserve the existing skill's explicit "more than 7 days" rule.
    else if (daysBetween(target.lastChecked, date) > 7) dueTargets.push({...target, reason: "weekly_over_7_days"});
  }
  for (const application of [...snapshot.applications].sort(byId)) {
    if (application.stage === "Closed") continue;
    if (application.nextAction && !application.nextActionDate) {
      reviews.push({kind: "application", id: application.id, reason: "missing_action_date"});
    } else if (!application.nextAction && application.nextActionDate) {
      reviews.push({kind: "application", id: application.id, reason: "missing_action"});
    } else if (application.nextAction && application.nextActionDate && application.nextActionDate <= date) {
      followUps.push({...application, overdueDays: daysBetween(application.nextActionDate, date)});
    }
  }
  followUps.sort((a, b) => b.overdueDays - a.overdueDays || byId(a, b));
  return {
    schemaVersion: 1, mode: "read_only", date, timezone, dueTargets, followUps, reviews,
    counts: {targets: snapshot.targets.length, applications: snapshot.applications.length,
      dueTargets: dueTargets.length, followUps: followUps.length, reviews: reviews.length},
  };
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
const oneLine = (value: string) => value.replace(/\p{Cc}/gu, " ");
export function digest(plan: Plan): string {
  return [
    `Morning plan: ${plan.date} (${plan.timezone})`,
    "Read-only: no sites scanned and no business records changed.",
    `${plan.counts.dueTargets} targets due; ${plan.counts.followUps} follow-ups due; ${plan.counts.reviews} items need review.`,
    "", "Targets due:",
    ...plan.dueTargets.map((item) => `- ${oneLine(item.company)}: ${item.reason}`),
    "", "Follow-ups:",
    ...plan.followUps.map((item) => `- ${oneLine(item.company)}${item.role ? ` / ${oneLine(item.role)}` : ""}: ${oneLine(item.nextAction ?? "")} (${item.overdueDays ? `${item.overdueDays} days overdue` : "today"})`),
    "", "Review:",
    ...plan.reviews.map((item) => `- ${item.kind} ${item.id}: ${item.reason}`),
    "",
  ].join("\n");
}
