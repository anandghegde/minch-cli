export type CliCommand =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "run"; initialQuery?: string }
  | { kind: "invalid"; arg: string };

export function parseCliArgs(argv: string[]): CliCommand {
  const args = argv.filter((a) => a.trim() !== "");
  if (args.length === 0) return { kind: "run" };
  const a = args[0]!;
  if (a === "--version" || a === "-v") return { kind: "version" };
  if (a === "--help" || a === "-h") return { kind: "help" };
  if (a.startsWith("-")) return { kind: "invalid", arg: a };
  // Any remaining args are treated as an initial search query.
  return { kind: "run", initialQuery: args.join(" ") };
}

export const HELP_TEXT = `minch \u2014 a terminal torrent finder for public sources

usage
  minch                  open the search TUI
  minch "ubuntu 24.04"   open and run an initial search
  minch --version        print the version
  minch --help           show this help

once open:
  type to search every working public source at once
  \u2191/\u2193          move        s   sort results
  enter        search      y   copy magnet
  d / o        open magnet tab to switch Search / Sources
  ?            keys        q   quit

minch ships Prowlarr's public indexer definitions and runs them via a scoped
Cardigann interpreter \u2014 no Prowlarr server required. It is not a full Prowlarr
replacement and supports public sources only (no private trackers, no login).
`;
