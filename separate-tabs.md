Coding Prompt: Dedicated Tabs for Real-Debrid, TorBox, and Torrent Search
Background / Current State
minch-cli is an Ink (React-for-terminal) TUI. Navigation is a single tab cycle driven by  TAB_ORDER  in  src/ui/App.tsx :
// ts
const TAB_ORDER: View[] = ["search", "sources", "transfers"];
-  View  is defined in  src/ui/store.ts :  "splash" | "search" | "sources" | "transfers" .
- The  transfers  view ( src/ui/components/Transfers.tsx ) currently shows a merged, newest-first list across every configured provider (TorBox + Real-Debrid), rendered from  store.transfers .
- Transfers are produced by  useTransfers(configuredDebrid)  ( src/ui/hooks/useTransfers.ts ), which polls all configured providers concurrently and merges them. It also returns  perProvider  state (per-id loading/error).
- Providers are provider-agnostic behind the  DebridProvider  interface ( src/debrid/types.ts ), with ids  "torbox" | "realdebrid"  and labels in  PROVIDER_LABELS .
- Global keybindings, footer hints, and the store are all wired in  App.tsx ; the help map lives in  src/ui/components/HelpOverlay.tsx .
Goal
Replace the single unified Transfers tab with three explicit tabs:
1. Search — the existing torrent search view (rename its user-facing label to "Torrent Search"; keep the  search  view internally).
2. Real-Debrid — transfers for Real-Debrid only.
3. TorBox — transfers for TorBox only.
The Sources tab stays. New tab order should be:
// ts
const TAB_ORDER: View[] = ["search", "realdebrid", "torbox", "sources"];
(Adjust ordering to taste, but Search first, Sources last.)
Design Decisions & Requirements
1. Views & routing ( src/ui/store.ts ,  src/ui/App.tsx )
- Extend  View  to  "splash" | "search" | "sources" | "realdebrid" | "torbox" . Remove  "transfers"  (or keep it as a deprecated alias that redirects to  realdebrid  — prefer removing it and updating all references).
- The two provider views should reuse one component parameterized by  DebridId  rather than duplicating  Transfers.tsx . Rename/refactor  Transfers.tsx  into a  ProviderTransfers  component that takes a  provider: DebridId  prop (plus the existing  active  prop).
-  App.tsx  render switch: route  realdebrid / torbox  to  <ProviderTransfers provider={...} active={...} /> .
2. Per-provider transfer data ( useTransfers.ts  + store)
-  useTransfers  already returns everything needed: it merges all providers but each  Transfer  carries  .provider . Two viable approaches — prefer (a) for minimal churn:
- (a) Keep  useTransfers  merging as-is; expose a store selector/helper  transfersFor(provider: DebridId)  that filters  store.transfers  by  .provider . Per-provider error comes from the existing  transfersError[providerId] ; per-provider "updated at" can stay global ( transfersUpdatedAt ) or be added to  perProvider .
- (b) Alternatively expose  perProvider  transfers directly. Only do this if filtering proves insufficient.
- The  ProviderTransfers  component should show only that provider's transfers, its own empty/loading/error state (from  perProvider[provider] ), and the provider label in the header instead of a per-row badge (the badge column becomes redundant and can be dropped to reclaim width).
3. Empty / unconfigured states
- If the selected provider is not configured, the tab should show a clear message: e.g. "Real-Debrid isn't configured. Press  a  to add a key in Accounts." (Mirror the existing  !store.anyDebridConfigured  copy, but scoped to the one provider via  getProvider(id, config).isConfigured()  — expose a helper on the store or compute from  debridProviders .)
- If configured but empty: "No Real-Debrid transfers yet. Press  b  on a search result to send one here."
4. Sending to debrid still works
- The search-result  b  action ( sendToDebrid  in  App.tsx ) currently sets  setView("transfers")  after a successful add. Update it to navigate to the matching provider tab ( setView(result.provider ... )  → use the provider the item was sent to:  setView(providerId === "realdebrid" ? "realdebrid" : "torbox") ).
- Likewise  downloadLocally  sets  setView("transfers")  — route it to the transfer's own provider tab ( transfer.provider ).
5. Footer hints & Help overlay
- In  App.tsx , the  footerHints  ternary keys off  view === "transfers" . Update so both  realdebrid  and  torbox  show the transfer hints (Move / Download / Cancel / Open / Remove / Keys), and update the "tab" hint label appropriately.
- Update  TAB_ORDER -derived tab labels wherever shown, and update  HelpOverlay.tsx :
- Change the Navigate hint  tab  label from  "Search / Sources / Transfers"  to reflect the new set (e.g.  "Search / Real-Debrid / TorBox / Sources" ).
- Keep the "Transfers" help group but title it generically (e.g. "Debrid tabs") since it now applies to both provider tabs.
- The search view's footer "tab" hint currently says "Sources"; make sure the cycle labels stay coherent.
6. Splash / boot
- No change to boot logic, but confirm the first view after boot remains  search .
7. Tests
-  test/app.test.tsx  and  test/app-debrid.test.tsx  and  test/useTransfers.test.tsx  likely assert on the  transfers  view / merged list. Update them:
- Tab cycling now includes  realdebrid  and  torbox .
- Assert each provider tab shows only its own transfers.
- Assert unconfigured-provider messaging.
- Assert  sendToDebrid  navigates to the correct provider tab.
- Keep tests offline (mocked providers), consistent with the existing suite.
Acceptance Criteria
-  tab  cycles Search → Real-Debrid → TorBox → Sources → Search.
- Real-Debrid tab lists only Real-Debrid transfers; TorBox tab lists only TorBox transfers. All existing per-row actions ( l  download,  c  cancel,  o  open,  x  remove,  r  refresh, multi-file picker) work unchanged within each tab.
- Local downloads panel still renders under whichever provider tab initiated it (scope the shown downloads by  transferId 's provider, or show all — pick and document one; scoping to the active provider is cleaner).
- Sending a result to a provider jumps to that provider's tab.
- Unconfigured provider tabs show actionable guidance.
-  bun test  (or the repo's  pnpm/npm test ) passes; typecheck is clean.
Implementation Notes / Gotchas
-  ProviderTransfers  must keep its own cursor state; since it's mounted per-view, that's automatic, but ensure the cursor clamps when the filtered list length changes (existing effect already does this against  transfers.length  — point it at the filtered list).
- The per-row provider badge column ( PROVIDER_LABELS[t.provider] ) is redundant in a single-provider view; remove it and widen  nameW .
- Don't break the  a  (Accounts) overlay or  ?  help — they're global and provider-agnostic.
- Keep  useTransfers  polling once for all providers (don't instantiate it per tab) — it lives at the  App  level and feeds the store, so both tabs share one poll loop.
Files to touch
-  src/ui/store.ts  —  View  type, optional  transfersFor  helper, per-provider configured flag.
-  src/ui/App.tsx  —  TAB_ORDER , view routing,  footerHints ,  sendToDebrid / downloadLocally  navigation.
-  src/ui/components/Transfers.tsx  → refactor to  ProviderTransfers  (param by  DebridId ).
-  src/ui/components/HelpOverlay.tsx  — tab labels/help groups.
- Tests:  test/app.test.tsx ,  test/app-debrid.test.tsx ,  test/useTransfers.test.tsx 
