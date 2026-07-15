import { render } from "ink";
import { parseCliArgs, HELP_TEXT } from "./cli/args";
import { flushConfigWrites, getLastConfigSaveError, loadConfig } from "./config/config";
import {
  formatDiscoveryUsageReport,
  formatDiscoveryRatingsDiagnostics,
  readDiscoveryRatingsDiagnostics,
  readDiscoveryUsageReport,
} from "./discovery/diagnostics";
import { sanitizeDiscoveryText } from "./discovery/security";
import { App } from "./ui/App";
import {
  flushLogs,
  getLastLogWriteError,
  getLogFilePath,
  logError,
  logEvent,
  registerLogSecrets,
} from "./util/logger";
import { VERSION } from "./version";

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeDiscoveryText(message, [
    process.env.TMDB_READ_TOKEN ?? "",
    process.env.STREAMING_AVAILABILITY_API_KEY ?? "",
    process.env.MDBLIST_API_KEY ?? "",
    process.env.APIFY_API_TOKEN ?? "",
    process.env.MINCH_TORBOX_KEY ?? "",
    process.env.MINCH_RD_TOKEN ?? "",
  ]) || "Unexpected error";
}

function startTui(initialQuery?: string): void {
  logEvent("info", "app.session.started", {
    version: VERSION,
    node: process.version,
    platform: process.platform,
    terminal: process.env.TERM ?? "unknown",
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    initialQuery: initialQuery ? "present" : "absent",
    logFile: getLogFilePath(),
  });
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
    logEvent("info", "app.session.ending", { exitCode: code });
    try {
      app?.unmount();
    } catch (error) {
      logError("app.unmount.failed", error);
    }
    // Do not let a stalled filesystem prevent terminal restoration forever, but
    // give an already-enqueued atomic config save a chance to finish first.
    await Promise.race([Promise.all([flushConfigWrites(), flushLogs()]), wait(1500)]);
    restoreTerminal();
    const saveError = getLastConfigSaveError();
    const logWriteError = getLastLogWriteError();
    if (saveError) console.error(`Failed to save config: ${safeErrorMessage(saveError)}`);
    if (logWriteError) console.error(`Failed to write app log: ${safeErrorMessage(logWriteError)}`);
    process.exit(saveError || logWriteError ? 1 : code);
  }

  const app = render(<App initialQuery={initialQuery} onQuit={() => void forceExit(0)} />, {
    exitOnCtrlC: false,
  });

  app
    .waitUntilExit()
    .then(() => void forceExit(0))
    .catch((error: unknown) => {
      logError("app.render.failed", error);
      restoreTerminal();
      console.error(`${safeErrorMessage(error)}\nLog: ${getLogFilePath()}`);
      void flushLogs().finally(() => process.exit(1));
    });

  process.on("SIGINT", () => {
    logEvent("info", "app.signal.received", { signal: "SIGINT" });
    void forceExit(0);
  });
  process.on("SIGTERM", () => {
    logEvent("info", "app.signal.received", { signal: "SIGTERM" });
    void forceExit(0);
  });
  process.on("exit", restoreTerminal);
  process.on("uncaughtException", (error) => {
    logError("process.uncaught_exception", error);
    restoreTerminal();
    console.error(`${safeErrorMessage(error)}\nLog: ${getLogFilePath()}`);
    void flushLogs().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    logError("process.unhandled_rejection", reason);
    restoreTerminal();
    console.error(`${safeErrorMessage(reason)}\nLog: ${getLogFilePath()}`);
    void flushLogs().finally(() => process.exit(1));
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
  if (cmd.kind === "log-file") {
    console.log(getLogFilePath());
    return;
  }
  if (cmd.kind === "discovery-status") {
    try {
      const config = await loadConfig();
      registerLogSecrets([
        config.discovery?.tmdb?.readToken,
        config.discovery?.streamingAvailability?.apiKey,
        config.discovery?.apify?.apiToken,
        config.discovery?.mdblist?.apiKey,
        config.debrid?.torbox?.apiKey,
        config.debrid?.realdebrid?.token,
      ]);
      const [usage, ratings] = await Promise.all([
        readDiscoveryUsageReport(),
        readDiscoveryRatingsDiagnostics(config),
      ]);
      console.log(`${formatDiscoveryUsageReport(usage)}\n\n${formatDiscoveryRatingsDiagnostics(ratings)}`);
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
  logError("app.startup.failed", error);
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
});
