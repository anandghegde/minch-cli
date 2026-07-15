import {
  FIRECRAWL_API_BASE_URL,
} from "../config";
import {
  disposeResponse,
  fetchResilient,
  HttpError,
  USER_AGENT,
  type FetchImpl,
  type SleepImpl,
} from "../../util/net";

export class FirecrawlContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirecrawlContractError";
  }
}

export interface FirecrawlScrapeOptions {
  apiKey: string;
  url: string;
  formats?: readonly ("html" | "markdown")[];
  fetchImpl: FetchImpl;
  signal?: AbortSignal;
  retries?: number;
  sleepImpl?: SleepImpl;
  baseUrl?: string;
}

export interface FirecrawlScrapeResult {
  html?: string;
  markdown?: string;
  sourceUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned || undefined;
}

/** Scrape a single URL via Firecrawl v2 and return requested content formats. */
export async function firecrawlScrape(
  options: FirecrawlScrapeOptions,
): Promise<FirecrawlScrapeResult> {
  const formats = options.formats ?? ["html"];
  const base = (options.baseUrl ?? FIRECRAWL_API_BASE_URL).replace(/\/$/, "");
  const endpoint = `${base}/v2/scrape`;
  const response = await fetchResilient(endpoint, {
    method: "POST",
    fetchImpl: options.fetchImpl,
    retries: options.retries ?? 1,
    ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {}),
    signal: options.signal,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({
      url: options.url,
      formats: [...formats],
    }),
  });
  if (!response.ok) {
    await disposeResponse(response);
    throw new HttpError(response.status, `Firecrawl scrape failed (HTTP ${response.status})`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new FirecrawlContractError("Firecrawl response is not valid JSON");
  }
  const data = isRecord(payload)
    ? (isRecord(payload.data) ? payload.data : payload)
    : undefined;
  if (!data) {
    throw new FirecrawlContractError("Firecrawl response is missing data");
  }
  const html = text(data.html);
  const markdown = text(data.markdown);
  if (!html && !markdown) {
    throw new FirecrawlContractError("Firecrawl response has no html or markdown content");
  }
  return {
    ...(html ? { html } : {}),
    ...(markdown ? { markdown } : {}),
    sourceUrl: options.url,
  };
}
