---
name: threa-public-api
description: Use Threa's documented public API correctly. Use when listing/searching streams, messages, memos, attachments, bot runtime sessions/invocations, checking stream status, or operating against Threa from scripts/curl.
---

# Threa Public API

Use this skill whenever a task needs Threa data or actions through HTTP/API.

## First principles

- Prefer the documented **public API** under `/api/v1/workspaces/:workspaceId/...`.
- Do **not** use legacy app endpoints like `/api/workspaces/...` unless the task is explicitly about internal app routes.
- Always check HTTP status codes. Do not parse an error JSON as if it were success data.
- If auth/scope fails, stop and report the exact endpoint + status + error; do not silently switch to a heuristic.

## Documentation sources

Public/LLM-accessible docs:

- `https://threa.io/developers`
- `https://threa.io/llms.txt`
- `https://threa.io/llms-full.txt`
- `https://threa.io/openapi.json`

Repo sources:

- `/Users/kristofferremback/dev/personal/threa/README.md`
- `/Users/kristofferremback/dev/personal/threa/apps/public-site/src/pages/developers/`
- `/Users/kristofferremback/dev/personal/threa/apps/public-site/scripts/build-llms.ts`
- `/Users/kristofferremback/dev/personal/threa/docs/public-api/openapi.json`
- `/Users/kristofferremback/dev/personal/threa/apps/backend/src/routes.ts`
- `/Users/kristofferremback/dev/personal/threa/apps/backend/src/features/public-api/`

If unsure, read the OpenAPI spec or developer markdown before acting.

## Local credentials

Usual config files:

- Pi remote: `~/.pi/agent/threa-remote.json`
- Claude channel: `~/.claude/threa-channel/config.json`

They normally contain:

- `baseUrl` such as `https://app.threa.io`
- `workspaceId` such as `ws_...`
- `apiKey`

Use an Authorization bearer header:

```bash
-H "authorization: Bearer $KEY"
```

## Safe curl pattern

Use `curl -w` so status is visible and treat non-2xx as failure:

```bash
CFG=~/.pi/agent/threa-remote.json
BASE=$(jq -r .baseUrl "$CFG")
WS=$(jq -r .workspaceId "$CFG")
KEY=$(jq -r .apiKey "$CFG")

curl -sS -w '\nHTTP %{http_code}\n' \
  "$BASE/api/v1/workspaces/$WS/streams?limit=20" \
  -H "authorization: Bearer $KEY"
```

If `jq` is unavailable, use Python:

```bash
python3 - <<'PY'
import json
cfg=json.load(open('/Users/kristofferremback/.pi/agent/threa-remote.json'))
print(cfg['baseUrl'], cfg['workspaceId'], cfg['apiKey'])
PY
```

## Common operations

### List/search streams

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "$BASE/api/v1/workspaces/$WS/streams?limit=50" \
  -H "authorization: Bearer $KEY"

curl -sS -w '\nHTTP %{http_code}\n' \
  "$BASE/api/v1/workspaces/$WS/streams?query=voice&limit=20" \
  -H "authorization: Bearer $KEY"
```

Required scope: `streams:read`.

### Get a stream / check archived status

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "$BASE/api/v1/workspaces/$WS/streams/$STREAM_ID" \
  -H "authorization: Bearer $KEY"
```

Notes:

- Public `getStream` returns active accessible streams.
- Archived streams may be absent from this endpoint depending on API behavior; consult `openapi.json` / current backend before interpreting 404.
- For cleanup decisions, explicitly distinguish: `active`, `archived`, `not accessible`, `not found`, `rate-limited`, `auth/scope failure`, `unknown`.

### Read messages

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  "$BASE/api/v1/workspaces/$WS/streams/$STREAM_ID/messages?limit=20" \
  -H "authorization: Bearer $KEY"
```

### Search messages

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  -X POST "$BASE/api/v1/workspaces/$WS/messages/search" \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"query":"search text","limit":20}'
```

### Search memos

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  -X POST "$BASE/api/v1/workspaces/$WS/memos/search" \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"query":"decision text","limit":10}'
```

### Bot runtime session creation

```bash
curl -sS -w '\nHTTP %{http_code}\n' \
  -X POST "$BASE/api/v1/workspaces/$WS/bot-runtime/sessions" \
  -H "authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"runtimeKind":"claude-code-channel","instanceId":"...","runtimeSessionId":"...","displayName":"..."}'
```

## Cleanup workflow for Threa worktrees

When the user asks to remove local worktrees based on scratchpad/archive state:

1. Inventory local worktrees: `git worktree list`.
2. Map worktrees to scratchpads/stream IDs from harness inventory, local logs, config, or explicit user-provided URLs.
3. Query the public API with `/api/v1` endpoints and record HTTP status for each stream.
4. Categorize each worktree as one of:
   - confirmed archived / inactive per API/docs
   - confirmed active
   - not accessible / missing scope
   - unknown/no mapping
5. Only remove worktrees that are confirmed safe by the user's requested criterion. Ask before using PR merge/closed state as a fallback.
6. Report the exact basis for every removed or retained worktree.

## Failure handling

- `401`: missing/invalid bearer token or wrong API host.
- `403`: valid key but missing access/scope or stream not accessible.
- `404`: endpoint/stream not found; verify `/api/v1`, workspace id, stream id, and archived semantics in docs.
- `429`: rate limited; wait/retry rather than changing strategy.

Never present a heuristic result as an API-verified result.
