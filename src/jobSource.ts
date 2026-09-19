import { AppError } from "./errors.js";

// No adapter for either host exists yet (Slice 3.1/3.2 add Greenhouse and
// Lever). The allowlist exists now so that a future adapter cannot widen its
// own reach: it is enforced centrally, not by each adapter's own discipline.
export const APPROVED_JOB_SOURCE_HOSTS = ["boards-api.greenhouse.io", "api.lever.co"] as const;

type FetchInit = {method?: string; headers?: Record<string, string>};
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Wait = (milliseconds: number) => Promise<void>;

// Mirrors src/notion.ts's readOnlyFetch: GET-only, host-allowlisted, no
// redirects, no credentials in the URL, bounded retries on transient status
// codes. Never contacted by this slice; no adapter calls it yet.
export function readOnlyJobFetch(network: Fetch = fetch,
  wait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  return async (input: string, init: FetchInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const approved = APPROVED_JOB_SOURCE_HOSTS as readonly string[];
    if (method !== "GET" || url.protocol !== "https:" || url.username || url.password || url.hash || !approved.includes(url.hostname)) {
      throw new AppError("POLICY", "The read-only job-source transport blocked an unsupported request.");
    }
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

// One page of untrusted, source-specific raw listings, already coerced by the
// adapter into the common field names src/normalize.ts expects (externalId,
// title, company, url, locations); normalize.ts does the actual validation.
export interface JobSourcePage {
  rawListings: unknown[];
  nextCursor: string | null;
}

// The only thing permitted to reach a job board. No adapter exists yet: this
// interface is the contract a Slice 3.1+ adapter must implement, narrowly
// scoped to "give me pages of raw listings for my one source."
export interface JobSourceAdapter {
  readonly sourceId: string;
  fetchPage(cursor: string | null): Promise<JobSourcePage>;
}

const MAX_PAGES = 100;

// Reads every page for one source, guarding against a non-advancing cursor
// and an unbounded page count the same way src/notion.ts's pagination loop
// does. An adapter failure (network, malformed page, timeout) is normalized
// to a SOURCE error unless the adapter already threw a specific AppError, so
// callers can isolate one source's failure without inspecting its internals.
export async function fetchAllListings(adapter: JobSourceAdapter): Promise<unknown[]> {
  const rawListings: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    let page: JobSourcePage;
    try {
      page = await adapter.fetchPage(cursor);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("SOURCE", `Job source "${adapter.sourceId}" could not be read. Retry later; no partial results were used.`);
    }
    rawListings.push(...page.rawListings);
    if (page.nextCursor === null) return rawListings;
    if (cursors.has(page.nextCursor)) throw new AppError("SOURCE", `Job source "${adapter.sourceId}" pagination did not advance. No partial results were used.`);
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new AppError("SOURCE", `Job source "${adapter.sourceId}" pagination exceeded the run budget. No partial results were used.`);
}
