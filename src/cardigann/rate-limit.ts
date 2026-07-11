/**
 * Serializes request starts at a source's advertised requests-per-second rate.
 * A governor is shared by search, probe, and detail resolution for one source.
 */
export interface RequestGovernor {
  wait(signal?: AbortSignal): Promise<void>;
}

export interface RequestGovernorOptions {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    function done(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Build a no-op governor for absent/invalid limits, otherwise space starts. */
export function createRequestGovernor(
  requestsPerSecond: number | undefined,
  options: RequestGovernorOptions = {},
): RequestGovernor {
  if (
    requestsPerSecond === undefined ||
    !Number.isFinite(requestsPerSecond) ||
    requestsPerSecond <= 0
  ) {
    return { wait: async (signal) => {
      if (signal?.aborted) throw abortError();
    } };
  }

  const intervalMs = 1000 / requestsPerSecond;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  let nextStartAt = 0;
  let queue: Promise<void> = Promise.resolve();

  return {
    wait(signal?: AbortSignal): Promise<void> {
      const reservation = queue.then(async () => {
        if (signal?.aborted) throw abortError();
        const current = now();
        const startAt = Math.max(current, nextStartAt);
        nextStartAt = startAt + intervalMs;
        if (startAt > current) await sleep(startAt - current, signal);
      });
      // A canceled request must not block the next request for this source.
      queue = reservation.catch(() => {});
      return reservation;
    },
  };
}
