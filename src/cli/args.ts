export type CliCommand =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "discovery-status" }
  | { kind: "run"; initialQuery?: string }
  | { kind: "invalid"; arg: string };

export function parseCliArgs(argv: string[]): CliCommand {
  const args = argv.filter((a) => a.trim() !== "");
  if (args.length === 0) return { kind: "run" };
  const a = args[0]!;
  if (a === "--version" || a === "-v") return { kind: "version" };
  if (a === "--help" || a === "-h") return { kind: "help" };
  if (a === "--discovery-status" && args.length === 1) {
    return { kind: "discovery-status" };
  }
  if (a.startsWith("-")) return { kind: "invalid", arg: a };
  // Any remaining args are treated as an initial search query.
  return { kind: "run", initialQuery: args.join(" ") };
}

export const HELP_TEXT = `minch \u2014 a terminal torrent finder for public sources

usage
  minch                  open the search TUI
  minch "ubuntu 24.04"   open and run an initial search
  minch --discovery-status  show local discovery request usage
  minch --version        print the version
  minch --help           show this help

once open:
  / or i       edit search · enter run search · s cycle sort
  \u2191/\u2193          move        s   sort results
  enter        run search  y copy magnet · a accounts
  tab          Search · Discover · Real-Debrid · TorBox · Sources · Settings
  Sources: e enable · t retest · T retest all · m mirror
  Debrid:  l download · c cancel · o open · x remove
  ?            keys        q quit

minch ships Prowlarr's public indexer definitions and runs them via a scoped
Cardigann interpreter \u2014 no Prowlarr server required. It is not a full Prowlarr
replacement and supports public sources only (no private trackers, no login).

${DISCOVERY_SOURCE_CLAIM_NOTICE}
${DISCOVERY_CREDITS_NOTICE}
${TMDB_REQUIRED_NOTICE}
${JUSTWATCH_ATTRIBUTION_NOTICE}
Source links: https://www.themoviedb.org · https://www.movieofthenight.com/about/api · https://www.blu-ray.com
`;
import {
  DISCOVERY_CREDITS_NOTICE,
  DISCOVERY_SOURCE_CLAIM_NOTICE,
  JUSTWATCH_ATTRIBUTION_NOTICE,
  TMDB_REQUIRED_NOTICE,
} from "../discovery/attribution";
