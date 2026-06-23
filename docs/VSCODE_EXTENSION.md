# Reckons.AI VS Code Extension

> Design document for the VS Code extension that injects a repo KB into the
> coding workflow via MCP, providing context-aware assistance and live KB
> updates from terminal or chat sessions.

## Vision

A developer opens their project in VS Code. Reckons.AI automatically finds
(or initializes) the repo's knowledge base, makes it available to the AI
assistant via MCP, and keeps it updated as the developer works. The KB
reduces context-gathering questions by providing persistent project memory,
while also enabling new queries the developer didn't know to ask.

## Architecture Overview

```
VS Code
  |
  |-- Extension (TypeScript, VS Code API)
  |     |-- KB Provider (reads/watches kbs/ folder or .reckons/ root)
  |     |-- MCP Bridge (wraps reckons-ai-mcp as child process)
  |     |-- Tree View (entity browser sidebar)
  |     |-- Inline Decorations (entity highlights in code)
  |     |-- Status Bar (KB stats, connection indicator)
  |     |
  |     |-- Commands:
  |     |     reckons.init       -- initialize KB for this repo
  |     |     reckons.ingest     -- ingest current file/selection as triples
  |     |     reckons.search     -- search KB from command palette
  |     |     reckons.addNote    -- quick-add a note to the KB
  |     |     reckons.refresh    -- refresh sources
  |     |     reckons.openWeb    -- open Reckons.AI web app
  |     |
  |     `-- Terminal Integration
  |           reckons CLI shim → MCP tool calls
  |
  `-- MCP Server (existing reckons-ai-mcp, spawned as child process)
        |-- --kb pointing to workspace kbs/ folder
        `-- File watching for live reload
```

## Phase 1: MCP Bridge + Auto-Inject

**Goal:** Zero-config KB injection into VS Code AI chat sessions.

### 1.1 Extension Activation

```jsonc
// package.json (VS Code extension manifest)
{
  "activationEvents": [
    "workspaceContains:**/kbs/*/kb.ttl",
    "workspaceContains:.reckons/kb.ttl",
    "workspaceContains:knowledge.ttl"
  ]
}
```

The extension activates when it detects a Reckons.AI KB in the workspace.
Detection order:
1. `kbs/*/kb.ttl` (workspace mode -- multiple KBs)
2. `.reckons/kb.ttl` (single-KB, project-scoped)
3. `knowledge.ttl` (legacy single-file)

### 1.2 MCP Server Lifecycle

On activation, the extension:
1. Resolves the `reckons-ai-mcp` binary (bundled or global install)
2. Spawns it with `--kb <detected-path>` pointing to the workspace root
3. Registers as an MCP server provider for VS Code's chat API
4. Monitors the process, restarts on crash

```typescript
// src/mcp-bridge.ts (sketch)
import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';

export class McpBridge {
  private proc: ChildProcess | null = null;
  private kbPath: string;

  constructor(kbPath: string) {
    this.kbPath = kbPath;
  }

  start() {
    this.proc = spawn('node', [
      require.resolve('reckons-ai-mcp/dist/index.js'),
      '--kb', this.kbPath
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    // Wire stdio to MCP protocol handler
    this.proc.stdout?.on('data', (chunk) => this.handleResponse(chunk));
    this.proc.stderr?.on('data', (chunk) => {
      const msg = chunk.toString();
      if (msg.includes('[reckons-mcp]')) {
        vscode.window.setStatusBarMessage(`KB: ${msg.trim()}`, 3000);
      }
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // Send JSON-RPC request, await response
    const id = Date.now();
    const request = JSON.stringify({
      jsonrpc: '2.0', id,
      method: 'tools/call',
      params: { name, arguments: args }
    });
    this.proc?.stdin?.write(request + '\n');
    // ... await response with matching id
  }
}
```

### 1.3 Auto-Inject into Chat

When VS Code's Copilot Chat (or any MCP-aware chat) starts a session:
- The extension registers the MCP server's tools as available
- Initial context injection: `kb_stats` + `kb_list_kbs` results are provided
  as system context, so the AI knows what knowledge is available
- The AI can then call `kb_search`, `kb_get_entity`, `kb_subgraph` etc.
  to answer questions using the KB

### 1.4 CLAUDE.md / .cursorrules Integration

The extension can auto-generate a `.claude/mcp.json` or equivalent config:

```jsonc
// .claude/mcp.json (auto-generated)
{
  "mcpServers": {
    "reckons-ai": {
      "command": "node",
      "args": ["node_modules/reckons-ai-mcp/dist/index.js", "--kb", "./kbs/"],
      "env": {}
    }
  }
}
```

This ensures the KB is available even without the VS Code extension
(e.g., in terminal-based Claude Code sessions).

## Phase 2: Live KB Updates

**Goal:** Update the KB in real-time as the developer works.

### 2.1 `kb_add_note` from Inline Actions

Code lens / right-click context menu:
- "Add to KB" on selected text → extracts entity + relation
- "Note: [selection]" → quick note with file:line source reference

### 2.2 Terminal Integration

The extension provides a `reckons` CLI shim in the integrated terminal:

```bash
# Search the KB
reckons search "authentication flow"

# Add a note
reckons note "auth-service" "depends-on" "redis-cache"

# Get entity context
reckons entity "user-model"

# Run a reckoning
reckons reckon "API is slow" "sub-100ms response times"
```

This pipes through to the MCP server via the bridge, so terminal and
chat sessions share the same live KB.

### 2.3 Git Hook Integration

Optional post-commit hook that ingests the commit message + changed files
as a source, keeping the KB current with development activity:

```bash
#!/bin/sh
# .git/hooks/post-commit (installed by reckons.init)
reckons ingest-commit HEAD
```

### 2.4 File Watcher → Auto-Ingest

Watch for changes to key files:
- `README.md`, `CHANGELOG.md`, `docs/**` → re-ingest documentation
- `package.json`, `Cargo.toml`, etc. → update dependency entities
- `.env.example` → update configuration entities

Configurable via `.reckons/watch.json`:
```jsonc
{
  "watch": [
    { "glob": "docs/**/*.md", "kind": "document" },
    { "glob": "*.md", "kind": "document" },
    { "glob": "package.json", "kind": "manifest" }
  ],
  "ignore": ["node_modules", "dist", ".git"]
}
```

## Phase 3: Visual KB Browser

**Goal:** Explore the KB visually within VS Code.

### 3.1 Tree View (Sidebar)

```
RECKONS.AI KB
  > Entities (142)
    > Person (12)
      - alice
      - bob
    > Service (8)
      - auth-service
      - api-gateway
    > Concept (45)
      ...
  > Sources (7)
    - README.md (23 triples)
    - api-docs.md (45 triples)
    - commit:abc123 (3 triples)
  > Recent Changes
    + auth-service .depends-on redis (pending)
    + api-gateway .has-version "2.1" (confirmed)
```

### 3.2 Webview Graph

Optional webview panel showing the 2D graph (reusing the SvelteKit graph
renderer compiled as a standalone bundle):

```
Command: Reckons: Show Knowledge Graph
```

### 3.3 Inline Entity Decorations

When a file mentions an entity known to the KB, show inline decorations:
- Hover: entity summary (type, key predicates, source)
- Gutter icon: entity type icon
- Go to definition: jump to the entity in the KB tree view

## Configuration

```jsonc
// .vscode/settings.json
{
  "reckons.kbPath": "./kbs/",           // auto-detected
  "reckons.autoInject": true,            // inject into chat sessions
  "reckons.watchFiles": true,            // auto-ingest watched files
  "reckons.gitHooks": false,             // post-commit ingest
  "reckons.statusBar": true,             // show KB stats in status bar
  "reckons.inlineDecorations": true,     // entity highlights in code
  "reckons.terminalShim": true           // reckons CLI in terminal
}
```

## Extension Structure

```
vscode-extension/
  package.json          # VS Code extension manifest
  tsconfig.json
  src/
    extension.ts        # Activation, command registration
    mcp-bridge.ts       # Spawns + communicates with reckons-ai-mcp
    kb-provider.ts      # Detects KB location, watches for changes
    tree-view.ts        # Sidebar entity browser
    code-lens.ts        # Inline "Add to KB" actions
    decorations.ts      # Entity highlight decorations
    terminal.ts         # CLI shim registration
    status-bar.ts       # KB stats indicator
    commands/
      init.ts           # reckons.init
      search.ts         # reckons.search
      ingest.ts         # reckons.ingest
      add-note.ts       # reckons.addNote
  test/
    extension.test.ts
  .vscodeignore
  README.md
```

## Relationship to Existing MCP Server

The VS Code extension is a **thin client** around the existing
`reckons-ai-mcp` server. It does NOT reimplement KB reading/writing.

```
                     VS Code Extension
                     (UI + lifecycle)
                           |
                     MCP Bridge (stdio)
                           |
                     reckons-ai-mcp
                     (existing server)
                           |
                     kbs/*/kb.ttl
                     (workspace files)
```

Changes to the MCP server benefit both the VS Code extension and
terminal-based usage (Claude Code, Cursor, etc.).

## Immediate Feedback Loop

The key insight: **immediate feedback is most pertinent and conscious**.

1. Developer writes code → AI chat uses KB to answer without asking
2. Developer discovers something → `reckons note` or inline action
3. KB updates → MCP server hot-reloads → next chat query sees the update
4. Review queue accumulates → developer opens web app periodically to
   confirm/reject, keeping the KB clean

The feedback cycle is seconds, not hours. The KB grows organically
alongside the code.

## MCP Server Enhancements Needed

To fully support the VS Code use case, the MCP server needs:

1. **`kb_ingest_file`** tool — ingest a file's content as triples
   (currently only the web app can ingest)
2. **`kb_recent_changes`** tool — show recent pending statements
3. **`kb_get_guidance`** tool — return KB title + description + purpose
   (the "central guidance" that all analyze features lean on)
4. **Streaming notifications** — notify the extension when KB changes
   (currently uses file watching, could add MCP notifications)

## Next Steps

1. Scaffold the extension with `yo code` (TypeScript, no bundler)
2. Implement Phase 1: MCP bridge + auto-inject
3. Test with Claude Code terminal sessions first (lowest friction)
4. Add Phase 2: live updates from editor actions
5. Phase 3: visual browser (stretch goal)
