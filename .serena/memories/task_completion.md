# Completion checklist

1. Preserve unrelated dirty-worktree changes and inspect scoped diffs.
2. Run targeted Vitest suites for changed behavior.
3. Run `rtk npm run typecheck`.
4. For broad/release changes run `rtk npm test`, `rtk npm run build`, and `rtk npm pack --dry-run`.
5. Confirm default tests use fixtures and no live network.
6. Scan changed fixtures/docs/cache code for secrets and terminal-control risks where relevant.
7. For `zero-cost-release-discovery-plan.md`, satisfy each numbered task/phase exit gate, update markers/Plan control/execution log/test evidence, and do not advance until the current gate is proven.