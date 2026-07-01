import os from "node:os";
import path from "node:path";

// Isolate persisted state per Vitest worker. The suite shares one fixed
// MINCH_STATE_DIR, so parallel workers otherwise race on the single
// config.json (config.test.ts rewrites it while the App tests boot from it).
// Files within a worker run sequentially, so a per-worker dir is enough and we
// keep file-level parallelism. Must run before any module imports
// src/config/paths.ts, which reads MINCH_STATE_DIR at import time.
const worker = process.env.VITEST_WORKER_ID ?? "0";
process.env.MINCH_STATE_DIR = path.join(os.tmpdir(), "minch-test-state", `w${worker}`);
