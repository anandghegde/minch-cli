# 1TamilMV Discover Feed Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a Firecrawl-backed TamilMV latest-releases Discover subtab that lists cleaned homepage titles and hands off to torrent search.

**Architecture:** New `tamilmv` discovery source + `tamilmv_latest` feedKind. Firecrawl scrapes the configured homepage URL; a Cheerio/parser extracts `ipsDataItem` topic titles; normalize to CatalogTitle/ReleaseEvent; aggregate into `feeds.tamilmv`; wire Discover UI feed + Settings credential/toggle.

**Tech Stack:** TypeScript, Vitest, existing discovery adapter/cache/budget patterns, Firecrawl REST `POST /v2/scrape`.

**Spec:** `docs/superpowers/specs/2026-07-15-tamilmv-discover-design.md`

---

## File map

| File | Role |
| --- | --- |
| `src/discovery/sources/firecrawl.ts` | Firecrawl scrape client |
| `src/discovery/sources/tamilmv.ts` | Adapter + HTML parser |
| `src/discovery/types.ts` | `DiscoverySource` += `tamilmv` |
| `src/discovery/adapter.ts` | capability `tamilmv_latest` |
| `src/discovery/request.ts` | feedKind `tamilmv_latest` |
| `src/discovery/config.ts` | Firecrawl + TamilMV config helpers |
| `src/config/config.ts` | Config types + coerce |
| `src/discovery/budget.ts` | tamilmv budget |
| `src/discovery/service.ts` | refresh policy |
| `src/discovery/aggregate.ts` | `feeds.tamilmv` |
| `src/discovery/diagnostics.ts` | usage line |
| `src/ui/discovery-state.ts` | feed id |
| `src/ui/hooks/useDiscovery.ts` | load target + cache kinds |
| `src/ui/components/Discover.tsx` | labels + date window default |
| `src/ui/components/Settings.tsx` | key + enable toggle |
| `src/ui/App.tsx` / `store.ts` | saveFirecrawlKey |
| `.env.example`, docs | document env |
| `test/discovery/tamilmv.test.ts` + fixture | unit tests |

### Task 1: Types, config, budget, request

Wire `"tamilmv"` through types, adapter capabilities, request feedKind, config coerce, budget (soft 40 / hard 60), refresh 6h/14d.

### Task 2: Firecrawl client + tests

`scrapeUrl({ apiKey, url, formats })` → HTML string; mock fetch tests.

### Task 3: Parser + adapter + tests

Fixture HTML; parse titles; adapter happy path / unconfigured / budget.

### Task 4: Aggregate + UI + settings

`feeds.tamilmv`, Discover tab, FEED_CACHE_KINDS, load targets, Settings, docs.

### Task 5: Verify

`npx vitest run` on affected tests + broader discovery suite.
