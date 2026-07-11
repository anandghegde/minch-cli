# Discovery security and privacy audit

Audit date: 10 July 2026.

## Credential handling

- TMDB uses a bearer header on the fixed `api.themoviedb.org` host. Streaming
  Availability uses `X-API-Key` on the fixed direct Movie of the Night host.
  Neither credential is added to a URL or source link.
- Environment credentials take precedence and are never persisted. Settings
  credentials are stored only in `config.json`, which is written atomically with
  mode `0600`; the temporary file is restricted before secret bytes are written.
- HTTP response bodies are not included in auth errors. Raw transport errors are
  terminal-sanitized and any matching in-memory credential is redacted before
  the error reaches source state or crash text.
- Authenticated adapters scrub their normalized output with the configured
  credential before returning it. If an upstream response echoes a key into a
  source URL, that URL is dropped rather than cached or displayed.

## Cache and terminal boundary

- Every adapter snapshot passes a terminal sanitizer immediately before the
  service writes or returns it. Cached snapshots are sanitized again when read,
  including the direct “All cached” path.
- The sanitizer removes C0 and C1 controls, escape characters, zero-width and
  bidi-control characters, and normalizes display whitespace. Discover also
  cleans provider, format, country, genre, attribution, and source-link text at
  the final Ink rendering boundary.
- Cache parsing rejects entries with credential-shaped fields such as API keys,
  authorization, tokens, passwords, or secrets. The cache itself is now written
  atomically with mode `0600`, although its schema contains no credential field.
- The local usage ledger stores counts only and is owner-only. No discovery
  diagnostics or telemetry are transmitted.

## Evidence

Credential-echo tests prove both authenticated adapters keep secrets out of
request URLs, normalized snapshots, source links, and the serialized cache.
Security/cache/config/format tests also cover safe transport errors, cache-field
rejection, `0600` modes, and terminal controls.

A names-only scan with both credentials configured reported:

```text
configured credentials: 2
workspace files containing either configured value: 0
discovery cache containing either configured value: 0
usage ledger containing either configured value: 0
config mode: 600
cache: absent at audit time
usage-ledger mode: 600
```

The repository fixture/documentation scan found no credential-shaped JSON field,
and the discovery source/script scan found no key/token query parameter, source
URL, or credential-bearing console output.
