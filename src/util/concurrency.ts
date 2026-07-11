/**
 * A bounded-concurrency pool that maps `items` through `fn`, running at most
 * `limit` invocations concurrently. Each item is processed exactly once in
 * insertion order; results are gathered with Promise.allSettled semantics so
 * one rejection never aborts the whole batch. Pass `onSettled` to observe each
 * result as it completes (streaming progress); it fires once per item, in
 * completion order, after the result is stored.
 *
 * Shared by health.probeAll, executor.resolveDownloadInfohashes,
 * useConcurrentSearch, and useTransfers — formerly four hand-rolled copies of
 * the same shared-index worker pool.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onSettled?: (item: T, index: number, result: PromiseSettledResult<R>) => void,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RangeError("mapPool limit must be a positive finite number");
  }
  if (items.length === 0) return [];

  const results: (PromiseSettledResult<R> | undefined)[] = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx]!;
      try {
        results[idx] = { status: "fulfilled", value: await fn(item, idx) };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
      // Progress observers must not be able to stop a worker and leave later
      // items unprocessed.
      try {
        onSettled?.(item, idx, results[idx]!);
      } catch {
        /* observer failures are deliberately isolated */
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, Math.floor(limit)), items.length) }, worker),
  );

  return results as PromiseSettledResult<R>[];
}
