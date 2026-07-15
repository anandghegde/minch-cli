import type {
  DiscoveryAdapter,
  DiscoverySnapshot,
  DiscoveryWarning,
} from "./adapter";
import { DiscoveryBudgetExceededError } from "./budget";
import type { DiscoveryRequest } from "./request";
import type {
  DiscoveryLoadOptions,
  DiscoveryLoadResult,
  DiscoveryRefreshResult,
  DiscoveryService,
} from "./service";
import type { CatalogTitle, DiscoverySource, ReleaseEvent } from "./types";
import type { NormalizedProvider } from "./normalize";
import { sanitizeDiscoveryData, sanitizeDiscoveryText } from "./security";

export type DiscoverySourceStatus =
  | "ready"
  | "refreshing"
  | "stale"
  | "disabled"
  | "unconfigured"
  | "auth-failed"
  | "quota-paused"
  | "failed";

export interface DiscoverySourceWarning extends DiscoveryWarning {
  source: DiscoverySource;
  sourceLabel: string;
}

export interface DiscoverySourceState {
  source: DiscoverySource;
  label: string;
  status: DiscoverySourceStatus;
  snapshot?: DiscoverySnapshot;
  warnings: DiscoverySourceWarning[];
  error?: Error;
  retryAfterMs?: number;
  /** Resolves the background stale refresh into its next stable source state. */
  refresh?: Promise<DiscoverySourceState>;
}

export interface DiscoveryAggregate {
  titles: CatalogTitle[];
  events: ReleaseEvent[];
  warnings: DiscoverySourceWarning[];
  usableSources: number;
  providers: NormalizedProvider[];
}

export interface DiscoverySourceInput {
  adapter: DiscoveryAdapter;
  request: DiscoveryRequest;
}

function snapshotWarnings(
  adapter: DiscoveryAdapter,
  snapshot: DiscoverySnapshot | undefined,
): DiscoverySourceWarning[] {
  return (snapshot?.warnings ?? []).map((warning) => ({
    ...warning,
    source: adapter.id,
    sourceLabel: adapter.label,
  }));
}

function isQuotaError(error: Error | undefined): boolean {
  if (!error) return false;
  if (error instanceof DiscoveryBudgetExceededError) return true;
  if ("status" in error && (error.status === 402 || error.status === 429)) return true;
  if (
    "code" in error &&
    (error.code === "quota" || error.code === "HTTP 402" || error.code === "HTTP 429")
  ) return true;
  return false;
}

function errorStatus(error: Error): number | undefined {
  return "status" in error && typeof error.status === "number" ? error.status : undefined;
}

function retryAfterMs(error: Error): number | undefined {
  return "retryAfterMs" in error && typeof error.retryAfterMs === "number"
    ? error.retryAfterMs
    : undefined;
}

function publicError(error: Error): Error {
  const safe = new Error(sanitizeDiscoveryText(error.message) || "Discovery request failed");
  safe.name = sanitizeDiscoveryText(error.name) || "Error";
  Object.assign(safe, sanitizeDiscoveryData(Object.fromEntries(Object.entries(error))));
  return safe;
}

function failureState(
  adapter: DiscoveryAdapter,
  snapshot: DiscoverySnapshot | undefined,
  error: Error,
): DiscoverySourceState {
  const quotaPaused = isQuotaError(error);
  const authFailed = errorStatus(error) === 401 || errorStatus(error) === 403;
  const contractDrift = error.name.endsWith("ContractError");
  const status: DiscoverySourceStatus = authFailed
    ? "auth-failed"
    : quotaPaused
    ? "quota-paused"
    : snapshot
      ? "stale"
      : "failed";
  const safeError = publicError(error);
  return {
    source: adapter.id,
    label: adapter.label,
    status,
    ...(snapshot ? { snapshot } : {}),
    warnings: [
      ...snapshotWarnings(adapter, snapshot),
      {
        source: adapter.id,
        sourceLabel: adapter.label,
        code: authFailed
          ? "auth-failed"
          : quotaPaused
            ? "quota-paused"
            : contractDrift
              ? "contract-drift"
              : "refresh-failed",
        message: safeError.message,
      },
    ],
    error: safeError,
    ...(retryAfterMs(error) !== undefined ? { retryAfterMs: retryAfterMs(error) } : {}),
  };
}

function settledRefreshState(
  adapter: DiscoveryAdapter,
  result: DiscoveryRefreshResult,
): DiscoverySourceState {
  if (result.status === "failed") {
    return failureState(adapter, result.snapshot, result.error ?? new Error("refresh failed"));
  }
  return {
    source: adapter.id,
    label: adapter.label,
    status: "ready",
    ...(result.snapshot ? { snapshot: result.snapshot } : {}),
    warnings: snapshotWarnings(adapter, result.snapshot),
  };
}

function sourceStateFromLoad(
  adapter: DiscoveryAdapter,
  loaded: DiscoveryLoadResult,
): DiscoverySourceState {
  if (loaded.error) return failureState(adapter, loaded.snapshot, loaded.error);
  if (loaded.refreshing && loaded.refresh) {
    return {
      source: adapter.id,
      label: adapter.label,
      status: "refreshing",
      ...(loaded.snapshot ? { snapshot: loaded.snapshot } : {}),
      warnings: snapshotWarnings(adapter, loaded.snapshot),
      refresh: loaded.refresh.then((result) => settledRefreshState(adapter, result)),
    };
  }
  return {
    source: adapter.id,
    label: adapter.label,
    status: loaded.cacheState === "stale" || loaded.cacheState === "expired" ? "stale" : "ready",
    ...(loaded.snapshot ? { snapshot: loaded.snapshot } : {}),
    warnings: snapshotWarnings(adapter, loaded.snapshot),
  };
}

export async function loadDiscoverySourceState(
  service: DiscoveryService,
  adapter: DiscoveryAdapter,
  request: DiscoveryRequest,
  options: DiscoveryLoadOptions = {},
): Promise<DiscoverySourceState> {
  if (adapter.isEnabled?.() === false) {
    return {
      source: adapter.id,
      label: adapter.label,
      status: "disabled",
      warnings: [],
    };
  }
  if (!adapter.isConfigured()) {
    return {
      source: adapter.id,
      label: adapter.label,
      status: "unconfigured",
      warnings: [],
    };
  }
  try {
    return sourceStateFromLoad(adapter, await service.load(adapter, request, options));
  } catch (error) {
    return failureState(
      adapter,
      undefined,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

export async function loadDiscoverySources(
  service: DiscoveryService,
  inputs: DiscoverySourceInput[],
  options: DiscoveryLoadOptions = {},
): Promise<DiscoverySourceState[]> {
  return Promise.all(
    inputs.map(({ adapter, request }) =>
      loadDiscoverySourceState(service, adapter, request, options)),
  );
}

/** Concatenate usable snapshots only; merge/dedupe remains a Phase 7 concern. */
export function aggregateDiscoveryStates(states: DiscoverySourceState[]): DiscoveryAggregate {
  return {
    titles: states.flatMap((state) => state.snapshot?.titles ?? []),
    events: states.flatMap((state) => state.snapshot?.events ?? []),
    warnings: states.flatMap((state) => state.warnings),
    usableSources: states.filter((state) => state.snapshot !== undefined).length,
    providers: states.flatMap((state) => state.snapshot?.providers ?? []),
  };
}
