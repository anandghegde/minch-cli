// Pull the latest public Cardigann definitions from the upstream
// Prowlarr/Indexers repo, filter to `type: public` definitions the scoped
// interpreter can run (no login), and vendor them into definitions/public.
//
// Usage: npm run sync:definitions
//
// Definitions are GPL-3.0 (upstream Prowlarr). See definitions/public/LICENSE
// and the README for attribution. This script only fetches/filters; it does not
// modify definition contents.

import { mkdir, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefinition, UnsupportedDefinitionError } from "../src/cardigann/loader";

const VERSION = "v11";
const TREE_URL =
  "https://api.github.com/repos/Prowlarr/Indexers/git/trees/master?recursive=1";
const RAW = `https://raw.githubusercontent.com/Prowlarr/Indexers/master/definitions/${VERSION}`;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "definitions", "public");

interface TreeEntry {
  path: string;
  type: string;
}

async function listDefinitionFiles(): Promise<string[]> {
  const res = await fetch(TREE_URL);
  if (!res.ok) throw new Error(`GitHub tree API returned ${res.status}`);
  const tree = (await res.json()) as { tree: TreeEntry[] };
  return tree.tree
    .filter(
      (t) =>
        t.path.startsWith(`definitions/${VERSION}/`) && t.path.endsWith(".yml"),
    )
    .map((t) => t.path.split("/").pop()!)
    .sort();
}

async function main(): Promise<void> {
  console.log(`Fetching ${VERSION} definition list from Prowlarr/Indexers...`);
  const files = await listDefinitionFiles();
  console.log(`Found ${files.length} definitions. Filtering to public/no-login...`);

  await mkdir(outDir, { recursive: true });

  let kept = 0;
  let skippedPrivate = 0;
  let skippedUnsupported = 0;
  const concurrency = 16;
  const keptFiles = new Set<string>();
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < files.length) {
      const name = files[idx++]!;
      try {
        const res = await fetch(`${RAW}/${name}`);
        if (!res.ok) continue;
        const yaml = await res.text();
        try {
          loadDefinition(yaml); // validates type=public, no login, runnable shape
        } catch (e) {
          if (e instanceof UnsupportedDefinitionError) {
            if (/public only|login/.test(e.message)) skippedPrivate++;
            else skippedUnsupported++;
          } else {
            skippedUnsupported++;
          }
          continue;
        }
        await writeFile(path.join(outDir, name), yaml, "utf8");
        keptFiles.add(name);
        kept++;
      } catch (e) {
        console.error(`  ! ${name}: ${(e as Error).message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, worker),
  );

  // Remove any vendored defs no longer present/eligible upstream.
  const existing = (await readdir(outDir)).filter((f) => f.endsWith(".yml"));
  let removed = 0;
  for (const f of existing) {
    if (!keptFiles.has(f)) {
      await rm(path.join(outDir, f));
      removed++;
    }
  }

  console.log(
    `Done. Vendored ${kept} public definitions ` +
      `(skipped ${skippedPrivate} private/login, ${skippedUnsupported} unsupported; removed ${removed} stale).`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
