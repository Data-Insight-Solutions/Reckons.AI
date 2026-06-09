# Reckons.AI MCP Server

Exposes a Reckons.AI knowledge base to any MCP-compatible AI agent (Claude Desktop, Cursor, Windsurf, etc.).

## Quick start

```bash
cd mcp-server
npm install
npm run build
```

## Usage

```bash
node dist/index.js --kb /path/to/your/knowledge.ttl
```

The `.ttl` file path should point to the `knowledge.ttl` inside your Reckons.AI **Workspace folder**
(Settings → Workspace → pick a directory).

Reckons.AI automatically writes a clean TTL export to `knowledge.ttl` in that folder after every
KB mutation (confirm, reject, merge, add). The server watches the file and reloads automatically.

`kb_add_note` writes new triples to `knowledge.pending.jsonl` in the same folder.
Reckons.AI reads and clears this file on the next page load, adding the entries to the review queue.

## Tools exposed

| Tool | Description |
|---|---|
| `kb_search` | BM25 full-text search over all triples |
| `kb_get_entity` | All facts about a named entity |
| `kb_list_entities` | List all entity IRIs |
| `kb_stats` | Triple/entity/source counts and last modified |
| `kb_add_note` | Queue a new triple for human review (writes to `.pending.jsonl`) |
| `kb_reckoning` | Assemble a Situation-Target context from KB for LLM synthesis |

## Claude Desktop config

Add to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "reckons": {
      "command": "node",
      "args": [
        "/absolute/path/to/reckons-ai/mcp-server/dist/index.js",
        "--kb",
        "/absolute/path/to/your/knowledge.ttl"
      ]
    }
  }
}
```

## Environment variable

Instead of `--kb`, you can set `RECKONS_KB_PATH`:

```bash
export RECKONS_KB_PATH=/path/to/knowledge.ttl
node dist/index.js
```
