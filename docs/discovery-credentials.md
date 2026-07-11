# Discovery credential conventions

Status: implemented. For the user-facing minimum setup, local paths, refresh
policy, quota behavior, and adapter toggles, see
[Discovery setup and operations](discovery-setup.md).

## Environment variables

| Variable | Secret | Accepted value | Purpose |
| --- | --- | --- | --- |
| `TMDB_READ_TOKEN` | Yes | Non-empty TMDB API Read Access Token | TMDB application authentication through the Bearer header |
| `TRAKT_CLIENT_ID` | Treat as sensitive configuration | Non-empty Trakt application Client ID | Reserved for a future approved Trakt adapter; it must not enable Trakt under the current terms decision |
| `STREAMING_AVAILABILITY_API_KEY` | Yes | Non-empty Movie of the Night developer-platform key | Streaming Availability authentication against the fixed direct endpoint |

Values are trimmed. An empty or whitespace-only value is unset. Environment variables take precedence over owner-only `config.json` Settings values. Credentials are never accepted as CLI arguments because process arguments can be visible to other local processes and shell history.

`TRAKT_CLIENT_ID` is named now to keep the future contract stable, but it is intentionally inactive. [ADR 001](decisions/001-zero-cost-discovery-sources.md) requires written Trakt approval before registration, live probes, implementation, or user setup instructions.

## Streaming Availability transport

The application supports only Movie of the Night's direct developer platform:

| Base URL | Authentication header |
| --- | --- |
| `https://api.movieofthenight.com/v4` | `X-API-Key` |

Resolution rules:

1. `STREAMING_AVAILABILITY_API_KEY` always means a direct developer-platform key. Its environment value overrides a persisted Settings value.
2. A missing key leaves only the Streaming Availability adapter unconfigured and produces actionable help. It must make no request.
3. Send the key only to the fixed direct host and only in `X-API-Key`.
4. Never send the key in a URL, query string, source link, cache key, error, notice, diagnostic, fixture, or log.
5. RapidAPI keys and endpoints are unsupported. Never inspect a key to guess its origin, retry it against another host, or auto-fallback to a marketplace transport.

These rules prevent a key from being disclosed to the wrong service or accidentally using a differently billed marketplace account.

## Other source authentication

- TMDB uses `TMDB_READ_TOKEN` only in `Authorization: Bearer <token>` against TMDB API hosts. An environment token overrides a persisted token.
- Blu-ray.com RSS has no credential.
- Trakt remains disabled under ADR 001. If written approval is obtained later, `TRAKT_CLIENT_ID` may be sent only in Trakt's `trakt-api-key` header and an environment value overrides a persisted value.

No maintainer credential or default key is bundled in source, fixtures, package files, or documentation.

## Settings behavior

The discovery Settings UI exposes the same names and rules:

- **TMDB token** — optional secret; show `TMDB_READ_TOKEN` as the environment alternative.
- **Streaming key** — optional direct-platform secret; show `STREAMING_AVAILABILITY_API_KEY` as the environment alternative and state that RapidAPI keys are unsupported.
- **Discovery adapter toggles** — TMDB, Streaming Availability, and Blu-ray RSS
  can each be disabled without deleting credentials or cache. Disabled-source
  cache is excluded from the All cached view.

Trakt has no Settings field or adapter. `TRAKT_CLIENT_ID` remains only a
reserved contract name until written approval exists.

Secret fields are masked, and the UI never renders a full value. An
environment-backed field is read-only in Settings, matching the existing
debrid-key convention. Help may name the environment variable but never echoes
its value.

## Local files and examples

`.gitignore` excludes `.env` and `.env.*`, except for the committed names-only
`.env.example`. The example deliberately has blank assignments and is not
loaded automatically by `minch-cli`; users must export variables through their
shell or an environment manager. Persisted Settings secrets use the owner-only
`config.json` path and atomic-write convention. Normalized discovery cache and
request-ledger files are separate, owner-only, and contain no credentials.
