# Commands — API & Slack Adapters (Scaffold)

> Central place to document **how to call** each command handler (HTTP & Slack).
> Keep sections short, copy the **Template** below when adding a new command.

---

## Conventions

- **Base URL:** `http://localhost:8080` (replace with Cloud Run URL in prod)
- **Method:** Unless stated otherwise, commands use `POST` with `application/json`
- **Time zone:** If omitted, period defaults to **JST** window (today 00:00 to -7d)
- **Dry run:** Prefer `dryRun: true` during testing to avoid DB writes
- **Examples:** Use `jq` for readability in terminal

---

## Table of Contents

- [handleConfigCommand](#handleconfigcommand)
- [handleRunCommand](#handleruncommand)
- [Template (copy to add new command)](#template-copy-to-add-new-command)

---

## handleConfigCommand

> **Purpose:** Fetch or update report settings (admin / Slack ops).

**Endpoint**

```
POST /api/weekly/config
```

**Actions**

- `"get"` — list/search settings (supports filters & field picking)
- `"set"` — update `enabled` for specific chats

**Quick Examples**

_Get (list last updated, limit 10):_

```bash
curl -X POST "$BASE_URL/api/weekly/config"   -H "Content-Type: application/json"   -d '{"action":"get","limit":10}' | jq
```

_Get by names or chats (enabled only):_

```bash
curl -X POST "$BASE_URL/api/weekly/config"   -H "Content-Type: application/json"   -d '{"action":"get","names":["Team A"],"enabled":true}' | jq
```

_Set enabled=false for a chat:_

```bash
curl -X POST "$BASE_URL/api/weekly/config"   -H "Content-Type: application/json"   -d '{"action":"set","chats":["-1001234567890"],"enabled":false}' | jq
```

**Response (examples)**

```jsonc
// action=get
{ "count": 1, "settings": [ /* LeanSetting[] */ ], "nextCursor": null }

// action=set
{ "message": "Update complete.", "updatedCount": 1, "failedCount": 0 }
```

**Notes**

- Pagination is currently **disabled** by design (cursor helpers kept commented for future use).
- Search uses `nameLower` prefix-range; default order is `updatedAt desc` then documentId.

---

## handleRunCommand

> **Purpose:** Manually trigger the weekly-report pipeline for a single chat (testing / re-runs).

**Endpoint**

```
POST /api/weekly/run
```

**Request Body (JSON)**  
_(brief schema; keep details in code comments)_

- `chatId` (string, required) — Target chat ID
- `startISO` (string, optional) — ISO-8601 with offset
- `endISO` (string, optional) — ISO-8601 with offset (exclusive)
- `tz` (string, optional, default `"Asia/Tokyo"`)
- `dryRun` (boolean, optional, default `true`)
- `notifySlack` (boolean, optional, default `false`)

**Quick Examples**

_Default (dry-run, last 7 days):_

```bash
curl -X POST "$BASE_URL/api/weekly/run"   -H "Content-Type: application/json"   -d '{"chatId":"-1001234567890"}' | jq
```

_Custom range (3 days, dry-run):_

```bash
curl -X POST "$BASE_URL/api/weekly/run"   -H "Content-Type: application/json"   -d '{
    "chatId":"-1001234567890",
    "startISO":"2025-10-17T00:00:00+09:00",
    "endISO":"2025-10-20T00:00:00+09:00",
    "dryRun":true
  }' | jq
```

_Persist to DB:_

```bash
curl -X POST "$BASE_URL/api/weekly/run"   -H "Content-Type: application/json"   -d '{"chatId":"-1001234567890","dryRun":false}' | jq
```

_Send to Slack (dry-run):_

```bash
curl -X POST "$BASE_URL/api/weekly/run"   -H "Content-Type: application/json"   -d '{"chatId":"-1001234567890","notifySlack":true}' | jq
```

**Response (summary)**

```jsonc
{
  "message": "Run completed (dry-run).",
  "dryRun": true,
  "notifySlack": false,
  "period": { "startISO": "...", "endISO": "...", "tz": "Asia/Tokyo" },
  "latencyMs": 12345,
  "resultPreview": { "summaryFirst200": "...", "finishReason": "STOP" },
}
```

**Notes**

- Uses `buildReportPayload` → `summarizeWithAI` → (optional) `saveReportToFirestore` → (optional) `sendReportToSlack`.
- When `dryRun=true`, nothing is persisted; use for safe local reproduction.

---

## Template (copy to add new command)

> Duplicate this section and replace placeholders.

**Command Name (e.g., `handleHistoryCommand`)**

**Endpoint**

```
POST /api/weekly/<path>
```

**Purpose**

- Short description of what this command does.

**Request Body (JSON)**

- `fieldA` (type, required/optional) — description
- `fieldB` (type, required/optional) — description

**Quick Examples**

```bash
curl -X POST "$BASE_URL/api/weekly/<path>"   -H "Content-Type: application/json"   -d '{ "<key>": "<value>" }' | jq
```

**Response (summary)**

```jsonc
{
  /* short representative example */
}
```

**Notes**

- Implementation pointers or gotchas (e.g., indexing, limits, defaults).
- Slack behavior if applicable.

---
