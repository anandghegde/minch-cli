# Suggested commands

Always prefix shell commands with `rtk`.

- Install: `rtk npm install`
- Run TUI in development: `rtk npm run dev`
- Run built entrypoint: `rtk npm start`
- Tests: `rtk npm test`
- Target tests: `rtk npm test -- --run test/path.test.ts`
- Typecheck: `rtk npm run typecheck`
- Build: `rtk npm run build`
- Package inspection: `rtk npm pack --dry-run`
- Refresh definitions: `rtk npm run sync:definitions`
- Git status/diff: `rtk git status --short`, `rtk git diff -- path`
- Search files/text: `rtk rg --files`, `rtk rg 'pattern' path`
- Semble semantic search: `semble search 'behavior' .`, then `semble find-related file line`
- Darwin utilities remain standard (`ls`, `cd`, `sed`, `find`) but invoke through `rtk`; use `rtk proxy <cmd>` if filtering interferes.