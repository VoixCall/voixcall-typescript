# Contributing

- `src/gen/` is generated from `openapi.json` by `npm run generate`. Do not edit it by hand; CI fails if it differs from a fresh generation.
- `openapi.json` is downloaded from the live API by `npm run fetch-spec`. Do not edit it by hand either; the daily spec-sync workflow keeps it current.
- The hand-written wrapper is everything else in `src/`. Run `npm run typecheck && npm test && npm run build` before opening a pull request.
- Never commit a real API key or access token, including in tests. Tests use mocked fetch only.
