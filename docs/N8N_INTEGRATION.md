# Reckons.AI + n8n Integration

> Private, self-hosted cloud sync and source monitoring for your knowledge bases.
> No SaaS dependency — your n8n VPS is the cloud backend.

## Architecture

```
Windows Laptop                          VPS (n8n)
┌─────────────────────┐                 ┌──────────────────────────┐
│ Claude Desktop      │                 │ Reckons KB Sync Hub      │
│   ├─ reckons MCP    │  ── webhooks ─> │   ├─ Upload (POST)       │
│   └─ n8n MCP        │                 │   ├─ Download (GET)      │
│                     │                 │   ├─ Status (GET)        │
│ Reckons.AI Web App  │  <── TTL ────── │   └─ Pending Notes (GET) │
│   └─ workspace/     │                 │                          │
│      └─ kb.ttl      │                 │ Reckons Source Monitor   │
└─────────────────────┘                 │   ├─ Every 6h: check URLs│
                                        │   ├─ Detect changes      │
                                        │   └─ Queue pending notes │
                                        └──────────────────────────┘
```

## Workflows

### 1. KB Sync Hub

Stores and serves KB snapshots via webhooks with content-hash deduplication.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook/reckons-kb-upload` | POST | Upload a KB snapshot |
| `/webhook/reckons-kb-download?kb=name` | GET | Download latest TTL (Content-Type: text/turtle) |
| `/webhook/reckons-kb-status` | GET | JSON summary of all stored KBs |
| `/webhook/reckons-kb-pending?kb=name` | GET | Pending notes from source monitors |

**Upload example:**
```bash
curl -X POST https://YOUR-N8N/webhook/reckons-kb-upload \
  -H "Content-Type: application/json" \
  -d "{\"kb_name\": \"my-project\", \"ttl_content\": \"$(cat workspace/knowledge.ttl)\"}"
```

**Download example:**
```bash
curl https://YOUR-N8N/webhook/reckons-kb-download?kb=my-project \
  -o knowledge.ttl
```

**Status example:**
```bash
curl https://YOUR-N8N/webhook/reckons-kb-status | jq
# { "kbs": [{ "kb_name": "my-project", "content_hash": "a1b2c3...", "content_length": 12345 }], "total": 1 }
```

### 2. Source Monitor

Watches URLs for content changes. When a change is detected, creates a pending
note that surfaces via the Sync Hub's `/reckons-kb-pending` endpoint.

**Add a URL to watch:**
```bash
curl -X POST https://YOUR-N8N/webhook/reckons-watch-url \
  -H "Content-Type: application/json" \
  -d '{"url": "https://docs.example.com/api", "kb_name": "my-project"}'
```

The monitor runs every 6 hours. Changed URLs produce pending notes like:
```json
{
  "subject": "urn:kbase:docs-example-com-api",
  "predicate": "urn:kbase:predicate/source-content-changed",
  "object": "Content changed (8234 bytes). New hash: f4e5d6c7...",
  "note": "Source URL content change detected. Review and re-ingest.",
  "addedByMcp": true
}
```

## Data Tables

| Table | Purpose |
|-------|---------|
| `reckons_kb_store` | KB snapshots (kb_name, content_hash, ttl_content, uploaded_at) |
| `reckons_watched_urls` | Monitored URLs (url, kb_name, content_hash, last_checked) |
| `reckons_pending_notes` | Change notifications (kb_name, subject, predicate, object_value, note, status) |

## n8n Workflow IDs

- Sync Hub: `gzL6AXn9iWo4GZxN`
- Source Monitor: `CvbUNSZkZVf4hJFG`

## Sync Script (PowerShell for Windows)

Save as `sync-kb.ps1` in your workspace folder:

```powershell
# Upload current KB to n8n
param(
    [string]$KbName = "default",
    [string]$N8nUrl = "https://YOUR-N8N"
)

$ttlPath = Join-Path $PSScriptRoot "knowledge.ttl"
if (-not (Test-Path $ttlPath)) {
    Write-Error "No knowledge.ttl found in $PSScriptRoot"
    exit 1
}

$ttlContent = Get-Content $ttlPath -Raw
$body = @{ kb_name = $KbName; ttl_content = $ttlContent } | ConvertTo-Json -Depth 1

$response = Invoke-RestMethod -Uri "$N8nUrl/webhook/reckons-kb-upload" `
    -Method POST -ContentType "application/json" -Body $body

Write-Host "Synced: $($response.kb_name) ($($response.content_length) bytes, hash: $($response.content_hash))"
```

## Sync Script (Bash for Linux/Mac)

```bash
#!/bin/bash
# sync-kb.sh - Upload current KB to n8n
KB_NAME="${1:-default}"
N8N_URL="${N8N_URL:-https://YOUR-N8N}"
TTL_FILE="${2:-./knowledge.ttl}"

if [ ! -f "$TTL_FILE" ]; then
    echo "Error: $TTL_FILE not found"
    exit 1
fi

TTL_CONTENT=$(cat "$TTL_FILE")
curl -s -X POST "$N8N_URL/webhook/reckons-kb-upload" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg name "$KB_NAME" --arg content "$TTL_CONTENT" \
    '{kb_name: $name, ttl_content: $content}')" | jq .
```

## Security

The webhook endpoints are public by default. To secure them:

1. In n8n, edit each webhook trigger node
2. Set Authentication to "Header Auth"
3. Create an HTTP Header Auth credential with a secret token
4. Pass the token in requests: `-H "Authorization: Bearer YOUR_SECRET"`

## Future Enhancements

- **Auto-sync from Reckons.AI**: Add fetch-from-n8n support in the web app's
  source refresh system. The app could pull from `/reckons-kb-pending` on load.
- **Claude Desktop MCP bridge**: Claude Desktop calls n8n MCP tools to trigger
  sync, add watch URLs, and query pending notes — all from conversation.
- **Webhook notifications**: Add Slack/email/ntfy alerts when source changes
  are detected or new KBs are uploaded.
- **Version history**: Extend `reckons_kb_store` to keep N versions per KB
  instead of upserting (change upsert → insert + cleanup).
