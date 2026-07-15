import { promises as fs } from "node:fs";
import path from "node:path";
import { appLogFile } from "../config/paths";
import { sanitizeDiscoveryData } from "../discovery/security";
import { serializeWrites } from "./atomic";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const writes = serializeWrites();
const sessionId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const registeredSecrets = new Set<string>();
let initialized = false;
let lastWriteError: Error | undefined;

function configuredSecrets(): string[] {
  return [
    process.env.TMDB_READ_TOKEN ?? "",
    process.env.STREAMING_AVAILABILITY_API_KEY ?? "",
    process.env.MDBLIST_API_KEY ?? "",
    process.env.APIFY_API_TOKEN ?? "",
    process.env.MINCH_TORBOX_KEY ?? "",
    process.env.MINCH_RD_TOKEN ?? "",
    ...registeredSecrets,
  ];
}

function serializedError(error: unknown): LogFields {
  if (!(error instanceof Error)) return { value: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...Object.fromEntries(Object.entries(error)),
  };
}

async function prepareLogFile(): Promise<void> {
  if (initialized) return;
  await fs.mkdir(path.dirname(appLogFile), { recursive: true });
  try {
    const stat = await fs.stat(appLogFile);
    if (stat.size >= MAX_LOG_BYTES) {
      await fs.rename(appLogFile, `${appLogFile}.1`).catch(async () => {
        await fs.rm(appLogFile, { force: true });
      });
    } else {
      await fs.chmod(appLogFile, 0o600);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  initialized = true;
}

export function registerLogSecrets(secrets: readonly (string | undefined)[]): void {
  for (const value of secrets) {
    if (value?.trim()) registeredSecrets.add(value.trim());
  }
}

export function logEvent(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
): void {
  const entry = sanitizeDiscoveryData({
    timestamp: new Date().toISOString(),
    level,
    event,
    sessionId,
    ...fields,
  }, configuredSecrets());
  void writes(async () => {
    await prepareLogFile();
    await fs.appendFile(appLogFile, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  }).catch((error: unknown) => {
    lastWriteError = error instanceof Error ? error : new Error(String(error));
  });
}

export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  logEvent("error", event, { ...fields, error: serializedError(error) });
}

export async function flushLogs(): Promise<void> {
  await writes.flush();
}

export function getLastLogWriteError(): Error | undefined {
  return lastWriteError;
}

export function getLogFilePath(): string {
  return appLogFile;
}
