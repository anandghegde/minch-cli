import { promises as fs } from "node:fs";
import path from "node:path";

/** Serialize async writes so concurrent saves never interleave/corrupt. */
export function serializeWrites(): (task: () => Promise<void>) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (task) => {
    chain = chain.then(task).catch(() => {});
    return chain;
  };
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
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  // writeFile's mode only applies when creating a fresh file; chmod explicitly
  // so an existing temp (or a default umask) can't widen the permissions.
  if (opts.mode !== undefined) await fs.chmod(tmp, opts.mode);
  await fs.rename(tmp, file);
}
