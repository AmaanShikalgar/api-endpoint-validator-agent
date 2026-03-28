# Architecture

## Design overview

The agent entrypoint is `src/agent.ts` → `runAgent()`. The runner (`src/run.ts`) passes:

- A Composio client (`composio`)
- A `connectedAccountId` string (in this project it is `"candidate"`)
- A list of endpoint definitions (`endpoints`)

`runAgent()` validates **each endpoint independently** and returns a `TestReport` with one `EndpointReport` per endpoint. Endpoints are executed via `composio.tools.proxyExecute()` and classified based on HTTP status codes.

## Connected account resolution

`src/run.ts` always passes `connectedAccountId = "candidate"`, which is a **user id**, not a concrete connected account id (`ca_...`). To avoid false failures, the agent resolves real connected account ids at startup:

- Calls `composio.connectedAccounts.list({ user_ids: ["candidate"], statuses: ["ACTIVE"] })`
- Builds a map: `toolkit slug -> connected account id`
- For each endpoint, selects the correct `ca_...` by reading the toolkit slug from `tool_slug` (e.g. `GMAIL_* -> gmail`, `GOOGLECALENDAR_* -> googlecalendar`)

This keeps `run.ts` unchanged and allows the same agent to work with any number of toolkits for the same user.

## Dependency resolution (path params)

Many endpoints contain path params like `{messageId}` / `{eventId}`. The agent resolves these dynamically:

1. Extract placeholder names from the path (regex on `{...}`)
2. Derive the collection/list path from the segments *before* the placeholder
   - Example: `/messages/{messageId}/trash` → list path `/messages`
3. Execute a matching GET “list” endpoint (if present), with minimal query params (e.g. `maxResults=1`)
4. Search the response for a usable identifier (generic recursive search for keys like `id` / `<paramName>`)
5. If the list response has no items, fall back to a matching POST “create” endpoint for that collection (if present) and extract `id` from the create response
6. Cache resolved ids per placeholder name to avoid repeated list/create calls

This supports out-of-order / parallel execution (GET-by-id can still succeed even if CREATE runs later), and generalizes across APIs that follow the common “list → detail” pattern.

## Request construction (query + body)

The agent constructs a minimal “reasonable request” from the endpoint schema:

- **Query params**: if `maxResults` exists, set it to `1` for deterministic, lightweight responses.
- **Body (POST/PUT/PATCH)**: builds an object containing only **required** fields from `parameters.body.fields`.
  - Basic type defaults: string → `"test"`, number → `1`, boolean → `true`, object → `{}`.
  - Time-like fields inferred from name/description use RFC3339 timestamps and a timezone.
  - If a field description indicates a special encoding format (e.g. base64url), the agent produces a syntactically valid value.

## Avoiding false negatives

False negatives usually come from the agent “calling it wrong”. Mitigations:

- **Heuristic retry for duplicated base prefixes**: some proxies/toolkits already prefix a versioned base path. If a 404 response body indicates duplicated segments (e.g. `/calendar/v3/calendar/v3/...`), the agent retries once with the redundant prefix stripped.
- **400 retry for missing body**: if a write endpoint returns 400 and the agent had no body but the schema has required fields, it retries once with a minimal required-field body.
- **Dependency fallback**: if list can’t yield an id, try create and use the returned id.
- **Response redaction + truncation**: responses are redacted (email addresses) and truncated to avoid leaking sensitive data and to keep the report small.

## Classification logic

Classification is intentionally simple and aligned with the prompt:

- **valid**: any 2xx
- **invalid_endpoint**: 404 or 405
- **insufficient_scopes**: 403
- **error**: everything else (400s, 5xx, timeouts, dependency resolution failures)

Each report includes a short `response_summary` explaining the reason and the HTTP code.

## Architecture pattern & tradeoffs

- **Pattern**: “one agent per endpoint” is implemented as one independent validation task per endpoint (parallelized for speed). A small shared cache is used only for dependency resolution and connected account mapping.
- **Tradeoffs**:
  - Path param resolution uses heuristics (list/create discovery + `id` extraction). With more time, I would add a more robust graph-based dependency planner and better schema-driven extraction (e.g. JSONPath candidates from examples).
  - Scope detection is based on HTTP 403 only. With more time, I would parse error bodies to distinguish “insufficient scopes” vs “account disabled” vs “policy blocked”.
  - Body construction is minimal and generic; for complex APIs it may need richer schema support (nested objects/arrays, enums, oneOf).
