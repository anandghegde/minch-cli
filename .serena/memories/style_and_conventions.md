# Style and conventions

- Strict TypeScript with `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, ES2022 target, bundler resolution, and React JSX.
- ESM imports; use `import type` for type-only imports.
- Double quotes, semicolons, trailing commas in multiline constructs, 2-space indentation.
- Prefer explicit interfaces/unions, pure helpers, dependency injection for tests, and deterministic clocks/fixtures.
- Vitest uses `describe`/`it`/`expect`; test helper factories commonly accept `Partial<T>` overrides.
- Keep network out of default tests. Preserve stable behavior/tiebreakers and sanitize upstream data.
- No configured formatter or linter script; match surrounding code and use typecheck/tests as gates.
- Repository instruction: prefix every shell command with `rtk`; use Semble for focused code search and Serena for symbol-level understanding/editing. `.codegraph` is absent, so CodeGraph is skipped.