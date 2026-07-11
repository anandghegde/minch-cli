import { render } from "ink";
import { parseCliArgs, HELP_TEXT } from "./cli/args";
import { flushConfigWrites, getLastConfigSaveError } from "./config/config";
import {
  formatDiscoveryUsageReport,
  readDiscoveryUsageReport,
} from "./discovery/diagnostics";
import { sanitizeDiscoveryText } from "./discovery/security";
import { App } from "./ui/App";
import { VERSION } from "./version";

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeDiscoveryText(message, [
    process.env.TMDB_READ_TOKEN ?? "",
    process.env.STREAMING_AVAILABILITY_API_KEY ?? "",
  ]) || "Unexpected error";
}

function startTui(initialQuery?: string): void {
  // Enter the alt-screen and hide the hardware cursor; the TUI draws its own.
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b]0;minch\x07");
  if (process.platform === "win32") process.title = "minch";

  let restored = false;
  function restoreTerminal(): void {
    if (restored) return;
    restored = true;
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }

  let exiting = false;
  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function forceExit(code = 0): Promise<void> {
    if (exiting) return;
    exiting = true;
    try {
      app?.unmount();
    } catch {}
    // Do not let a stalled filesystem prevent terminal restoration forever, but
    // give an already-enqueued atomic config save a chance to finish first.
    await Promise.race([flushConfigWrites(), wait(1500)]);
    restoreTerminal();
    const saveError = getLastConfigSaveError();
    if (saveError) console.error(`Failed to save config: ${safeErrorMessage(saveError)}`);
    process.exit(saveError ? 1 : code);
  }

  const app = render(<App initialQuery={initialQuery} onQuit={() => void forceExit(0)} />, {
    exitOnCtrlC: false,
  });

  app
    .waitUntilExit()
    .then(() => void forceExit(0))
    .catch((error: unknown) => {
      restoreTerminal();
      console.error(safeErrorMessage(error));
      process.exit(1);
    });

  process.on("SIGINT", () => void forceExit(0));
  process.on("SIGTERM", () => void forceExit(0));
  process.on("exit", restoreTerminal);
  process.on("uncaughtException", (error) => {
    restoreTerminal();
    console.error(safeErrorMessage(error));
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const cmd = parseCliArgs(process.argv.slice(2));
  if (cmd.kind === "help") {
    console.log(HELP_TEXT);
    return;
  }
  if (cmd.kind === "version") {
    console.log(`minch v${VERSION}`);
    return;
  }
  if (cmd.kind === "discovery-status") {
    try {
      console.log(formatDiscoveryUsageReport(await readDiscoveryUsageReport()));
    } catch {
      console.error("Unable to read local discovery request usage.");
      process.exitCode = 1;
    }
    return;
  }
  if (cmd.kind === "invalid") {
    console.error(`error: unknown argument '${sanitizeDiscoveryText(cmd.arg)}'\n`);
    console.error(HELP_TEXT);
    process.exitCode = 1;
    return;
  }
  startTui(cmd.initialQuery);
}

void main().catch((error: unknown) => {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
});
