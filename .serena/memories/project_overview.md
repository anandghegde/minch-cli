# minch-cli overview

- Purpose: zero-config terminal torrent finder for public sources, with a scoped Cardigann interpreter, bundled public Prowlarr definitions, native API/RSS sources, debrid integrations, and an Ink TUI.
- Runtime: Node.js >=20, TypeScript ESM, React 18 + Ink 5.
- Key dependencies: cheerio, fast-xml-parser, env-paths, undici, yaml.
- Structure: `src/cardigann` interpreter; `src/sources` source contracts/search/filtering; `src/ui` Ink screens/components/hooks; `src/config` persistence/paths; `src/debrid` and `src/download` integrations; `src/util` shared helpers; `definitions/public` vendored indexers; `test` Vitest suites/fixtures; `scripts` build/sync helpers.
- State is local JSON; default tests redirect state through `MINCH_STATE_DIR`.
- Current long-running goal: implement `zero-cost-release-discovery-plan.md` one verified numbered task at a time while preserving the dirty worktree.