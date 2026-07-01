import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefinition, UnsupportedDefinitionError } from "../cardigann/loader";
import type { CardigannDefinition } from "../cardigann/model";

// Resolve the bundled definitions directory. In dev (tsx) __dirname is
// src/sources; in the built bundle it's dist. The `definitions/` folder ships
// at the package root and is published via package.json "files", so we walk up
// from the module location until we find it.
function findDefinitionsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "definitions", "public"),
    path.join(here, "..", "definitions", "public"),
    path.join(here, "definitions", "public"),
    path.join(process.cwd(), "definitions", "public"),
  ];
  return candidates[0]!; // primary; existence is checked at load time
}

async function firstExistingDir(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "definitions", "public"),
    path.join(here, "..", "definitions", "public"),
    path.join(here, "definitions", "public"),
    path.join(process.cwd(), "definitions", "public"),
  ];
  for (const c of candidates) {
    try {
      const st = await fs.stat(c);
      if (st.isDirectory()) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

export interface LoadedDefinitions {
  definitions: CardigannDefinition[];
  /** ids that failed to load, with reasons (for diagnostics). */
  rejected: { id: string; reason: string }[];
}

/** Load and parse all bundled public Cardigann definitions. */
export async function loadBundledDefinitions(
  dir?: string,
): Promise<LoadedDefinitions> {
  const defsDir = dir ?? (await firstExistingDir()) ?? findDefinitionsDir();
  const definitions: CardigannDefinition[] = [];
  const rejected: { id: string; reason: string }[] = [];

  let files: string[];
  try {
    files = (await fs.readdir(defsDir)).filter((f) => f.endsWith(".yml"));
  } catch {
    return { definitions, rejected };
  }

  for (const file of files) {
    const id = file.replace(/\.yml$/, "");
    try {
      const yaml = await fs.readFile(path.join(defsDir, file), "utf8");
      definitions.push(loadDefinition(yaml));
    } catch (e) {
      rejected.push({
        id,
        reason:
          e instanceof UnsupportedDefinitionError
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  }
  definitions.sort((a, b) => a.name.localeCompare(b.name));
  return { definitions, rejected };
}
