import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Keep tests off the real user data dir: redirect persisted state into a temp
// folder via the MINCH_STATE_DIR override that src/config/paths.ts honors. The
// setup file refines this to a per-worker subdir so parallel files don't race
// on the shared config.json.
export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    env: {
      MINCH_STATE_DIR: path.join(os.tmpdir(), "minch-test-state"),
    },
  },
});
