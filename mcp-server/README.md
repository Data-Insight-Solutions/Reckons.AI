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
# Workspace mode (recommended) — scans kbs/{name}/{name}.ttl for every KB
# (legacy kbs/{name}/kb.ttl is still read as a fallback):
node dist/index.js --kb /path/to/workspace/

# Legacy single-file mode:
node dist/index.js --kb /path/to/knowledge.ttl
```

Point `--kb` at your Reckons.AI **Workspace folder** (Settings → Workspace → pick a directory),
or at a single exported `.ttl` file. Reckons.AI writes a clean TTL export after every KB mutation
(confirm, reject, merge, add); the server watches for file changes and reloads automatically.

`kb_add_note` queues entries for human review. In workspace mode it appends to
`kbs/{name}/pending.jsonl`; in single-file mode it writes a `{name}.pending.jsonl` sidecar.
Reckons.AI reads and clears these on the next page load, adding the entries to the review queue.

## Tools exposed (20)

| Tool | Description |
|---|---|
| `kb_list_kbs` | List all KBs in the workspace with triple counts |
| `kb_search` | BM25 full-text search over all triples |
| `kb_get_entity` | All facts about a named entity |
| `kb_list_entities` | List all entity IRIs |
| `kb_stats` | Triple/entity/source counts and last modified |
| `kb_add_note` | Queue a new triple for human review (writes to `pending.jsonl`) |
| `kb_subgraph` | Extract an N-hop neighbourhood around an entity |
| `kb_reckoning` | Assemble a Situation-Target context from KB for LLM synthesis |
| `kb_list_sources` | List all sources with kind, URI, and refresh status |
| `kb_request_refresh` | Request a refresh of one or all refreshable sources |
| `kb_git_status` | Current git branch, staged/modified files, recent commits |
| `kb_check_plan` | Check current work alignment against the KB |
| `kb_pending` | List queued proposals from pending.jsonl files |
| `kb_git_diff_triples` | Cross-reference git changes with KB entities |
| `kb_alignment_score` | Quantitative 0–1 alignment score with per-dimension breakdown |
| `kb_compress` | Compress KB context for LLM prompts (~60-70% token reduction) |
| `kb_local_extract` | Extract triples from text via a local Ollama model (opt-in) |
| `kb_local_summarize` | Summarize an entity subgraph or text via a local Ollama model (opt-in) |
| `kb_generate_page` | Draft a documentation-page markdown proposal via a local Ollama model (opt-in) |
| `kb_entity_markdown` | Deterministic (no LLM) rendering of one entity as markdown |

The local-Ollama tools (`kb_local_*`, `kb_generate_page`) are disabled unless `OLLAMA_BASE_URL`
is set; when disabled they return enablement instructions instead of failing.

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
