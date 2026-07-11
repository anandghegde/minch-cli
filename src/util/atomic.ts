import { promises as fs } from "node:fs";
import path from "node:path";

/** Serialize async writes so concurrent saves never interleave/corrupt. */
export interface SerializedWrites {
  (task: () => Promise<void>): Promise<void>;
  /** Wait until every task queued so far has settled. */
  flush(): Promise<void>;
}

export function serializeWrites(): SerializedWrites {
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    // Return the task's own promise so callers can observe a failure, while
    // keeping a recovered private chain so one failed save cannot block later
    // saves.
    const result = chain.then(task);
    chain = result.catch(() => {});
    return result;
  };
  enqueue.flush = () => chain;
  return enqueue;
}

export interface WriteJsonOptions {
  /** File permission bits, e.g. 0o600 to keep secrets owner-only. */
  mode?: number;
}

/** Write JSON via a temp file + rename so a crash never leaves a half file. */
export async function writeJsonAtomic(
  file: string,
  data: unknown,
  opts: WriteJsonOptions = {},
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    // Open and restrict an existing temp before any secret bytes are written.
    // `open`'s mode is only used for a new file, hence the explicit chmod.
    handle = await fs.open(tmp, "w", opts.mode);
    if (opts.mode !== undefined) await handle.chmod(opts.mode);
    await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, file);
  } catch (error) {
    await handle?.close().catch(() => {});
    // A failed save must not leave credentials in a less-protected temp file.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
