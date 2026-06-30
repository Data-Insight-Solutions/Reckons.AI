# Confluence KB Migration

> Bulk import from Confluence spaces into Reckons.AI knowledge graphs.
> Designed for large-scale migration (hundreds to thousands of pages) using local models to avoid API costs.

---

## Overview

Confluence organises knowledge into **spaces** containing **pages** with **child pages**, **labels**, and **attachments**. A space export produces a tree of HTML files with metadata. Reckons.AI can ingest this tree, extract semantic triples from each page, and build a navigable knowledge graph — with no cloud API credits required.

```
Confluence Space                    Reckons.AI KB
┌────────────────────┐              ┌──────────────────────┐
│ Space: Engineering │              │ KB: Engineering Wiki │
│  ├─ Architecture   │   extract   │  ├─ 847 entities     │
│  │  ├─ Microservices│  ───────>  │  ├─ 2,340 triples    │
│  │  └─ Data Layer  │   (local)   │  ├─ 12 entity types  │
│  ├─ Runbooks       │              │  └─ source provenance│
│  ├─ ADRs           │              │                      │
│  └─ Onboarding     │              │ Review: 2,340 pending│
│     └─ 143 pages   │              │ Graph: navigable     │
└────────────────────┘              └──────────────────────┘
```

---

## UX: "Ingest" → "Add"

The current tab label `ingest` is technical jargon. For non-technical users migrating from Confluence, the word is opaque. The proposal:

| Current | Proposed | Rationale |
|---------|----------|-----------|
| `ingest` (NavBar) | `add` | Universally understood verb |
| `ingest` (page kicker) | `add knowledge` | Describes the action |
| `/ingest` (route) | `/add` (with `/ingest` redirect) | Clean URL, backward compat |
| Vault tab | Batch | "Vault" is Obsidian jargon |
| Repo tab | Repository | Already clear |

New tab set for the Add page:

```
┌────────┬──────────┬─────┬──────────┬───────┬──────────┬────────────┐
│  note  │ document │ url │ batch ⟁  │ repo  │ calendar │ confluence │
└────────┴──────────┴─────┴──────────┴───────┴──────────┴────────────┘
```

The `confluence` tab handles the migration workflow described below.

---

## Export Formats (Ranked by Quality)

### 1. HTML Export (Recommended)

Confluence's built-in **Space Export** produces a ZIP of HTML files with a table of contents.

```
space-export.zip
├── index.html              # Table of contents with page links
├── Architecture_65601.html # Page content as styled HTML
├── Microservices_65602.html
├── Data-Layer_65603.html
├── ...
├── attachments/
│   └── 65601/
│       ├── diagram.png
│       └── schema.sql
└── styles/                 # Confluence CSS (ignorable)
```

**How to export:**
1. Space Settings → Content Tools → Export
2. Select "HTML" format
3. Choose "Normal Export" (includes all pages) or select specific pages
4. Download the ZIP

**Advantages:**
- No API key needed
- Full content with formatting
- Includes page hierarchy (TOC links)
- Attachments included
- Works with Confluence Cloud and Data Center

**Parse strategy:**
- Extract `<div id="main-content">` from each HTML file
- Strip Confluence chrome (navigation, sidebar, breadcrumbs)
- Preserve headings, lists, tables, code blocks as text
- Extract page title from `<title>` or `<h1>`
- Build parent-child relationships from `index.html` links

### 2. Confluence REST API

For ongoing sync rather than one-time migration.

```
GET /wiki/rest/api/content?spaceKey=ENG&expand=body.storage,metadata.labels
```

**Rate limits:** Confluence Cloud allows ~100 requests/minute. A 500-page space needs ~10 minutes to export (with pagination at 25 results/page).

**Advantages:**
- Programmatic, repeatable
- Includes labels and metadata
- Can filter by date for incremental sync

**Disadvantages:**
- Requires API token
- Rate limited
- Body format is Confluence Storage Format (XML-ish HTML)

### 3. XML Export

Full backup format. Very large, includes version history.

```
space-export.xml
├── entities.xml       # All pages, comments, attachments as XML entities
└── attachments/       # Binary files
```

**Not recommended** for migration — XML is massive and contains version history bloat.

---

## Chunking Strategy for Large Pages

The current extraction pipeline truncates at **12,000 characters** per source (see `extractor.ts:52`). Confluence pages can be much longer — architecture docs, runbooks, and ADRs often exceed 20,000 characters.

### Proposed: Sliding Window with Overlap

```
Page text (35,000 chars)
├── Chunk 1: chars 0–10,000      → extract triples → [t1, t2, t3, ...]
├── Chunk 2: chars 8,000–18,000  → extract triples → [t4, t5, t6, ...]
├── Chunk 3: chars 16,000–26,000 → extract triples → [t7, t8, t9, ...]
└── Chunk 4: chars 24,000–35,000 → extract triples → [t10, t11, ...]

Merge: deduplicate by (subject, predicate, object) → final triple set
```

**Parameters:**
- `CHUNK_SIZE`: 10,000 chars (safe for all model context windows)
- `CHUNK_OVERLAP`: 2,000 chars (catches facts split across boundaries)
- Deduplication: exact match on `(subject, predicate, object)` after slugification

**Why overlap matters:** A sentence like "The payment service depends on Redis for session storage" might span a chunk boundary. The 2,000-char overlap ensures it appears in at least one chunk completely.

### Context Header per Chunk

Each chunk gets a preamble so the model knows where it is:

```
Source: "Architecture — Microservices" (page 3 of 143, chunk 2 of 4)
Parent page: "Architecture"
Labels: microservices, backend, infrastructure

Text:
"""
[chunk content here]
"""
```

This helps the model produce consistent entity slugs across chunks (e.g., always `payment-service`, not `payment-svc` in chunk 2 and `payments-service` in chunk 3).

---

## Local Model Strategy

### Recommended: Ollama

Ollama runs models locally with no API cost, no data leaving the machine, and context windows large enough for extraction.

| Model | Size | Context | Quality | Speed | Recommended For |
|-------|------|---------|---------|-------|-----------------|
| `gemma3:4b` | 2.7GB | 128K | Good | Fast | Small spaces (<100 pages) |
| `gemma3:12b` | 8GB | 128K | Very good | Medium | Most migrations |
| `gemma3:27b` | 17GB | 128K | Excellent | Slow | High-value KBs |
| `qwen3:8b` | 5GB | 128K | Very good | Medium | Alternative to Gemma |
| `llama3.2:3b` | 2GB | 128K | Acceptable | Very fast | Quick first pass |

**Recommendation:** Use `gemma3:12b` for migration. It handles structured extraction well, has a large context window, and runs at ~15 tokens/sec on a modern GPU. For a 500-page space with 3 chunks average per page, that's ~1,500 LLM calls — approximately 2–4 hours on consumer hardware.

### Fallback: WASM (Browser-Only)

The built-in Qwen2.5-0.5B model runs entirely in the browser. Quality is lower, but:
- Zero setup required
- Works offline
- No GPU needed

**Best for:** Small spaces (<50 pages) where the user will carefully review every triple.

### Hybrid Strategy

For maximum quality without API cost:

```
Phase 1: Bulk extract with Ollama (gemma3:12b)
         → Fast, local, good quality
         → ~15 triples per page average

Phase 2: Entity normalisation (embedding model, already built in)
         → Deduplicates "payment-service" vs "payments-service"
         → Runs locally via BGE-small-en-v1.5

Phase 3: Review pass
         → User reviews in batches (50 triples at a time)
         → Bulk confirm/reject with filters

Phase 4: Optional cloud refinement
         → Re-extract only rejected/low-confidence triples with Claude
         → Typically <5% of total — minimal API cost
```

---

## Migration Pipeline

### Step 1: Upload ZIP

User selects the Confluence HTML export ZIP via the new `confluence` tab.

```typescript
interface ConfluenceImport {
  spaceName: string;
  pages: ConfluencePage[];
  totalChars: number;
  estimatedChunks: number;
  estimatedTime: string;  // "~2h 15m with gemma3:12b"
}

interface ConfluencePage {
  id: string;           // Confluence page ID from filename
  title: string;        // Extracted from <title> or <h1>
  htmlFile: string;     // Path within ZIP
  parentId?: string;    // Parent page ID from TOC
  labels: string[];     // Confluence labels
  textLength: number;   // Char count after HTML stripping
  chunks: number;       // Estimated chunk count
}
```

### Step 2: Preview & Configure

Before extraction starts, show the user:

```
┌─────────────────────────────────────────────────────┐
│ Confluence Import: Engineering Wiki                  │
│                                                      │
│ Pages:    143                                        │
│ Total:    2.4 MB of text content                     │
│ Chunks:   ~412 (at 10K chars each)                   │
│ Est time: ~2h 15m with gemma3:12b                    │
│                                                      │
│ Backend:  [Ollama ▼]  Model: [gemma3:12b ▼]         │
│                                                      │
│ Options:                                             │
│ ☑ Preserve page hierarchy as skos:broader            │
│ ☑ Convert labels to rdf:type                         │
│ ☑ Include page URLs as source provenance             │
│ ☐ Extract from attachments (PDFs, if OCR available)  │
│                                                      │
│ [Start Import]                  [Cancel]             │
└─────────────────────────────────────────────────────┘
```

### Step 3: Extraction Queue

Process pages sequentially with progress feedback:

```
┌─────────────────────────────────────────────────────┐
│ Importing: Engineering Wiki                          │
│                                                      │
│ ████████████░░░░░░░░░░░░░░░  42 / 143 pages         │
│                                                      │
│ Current: "Microservices Architecture" (chunk 2/3)    │
│ Triples so far: 634                                  │
│ Errors: 2 (will retry)                               │
│ Elapsed: 47m 12s                                     │
│ Remaining: ~1h 28m                                   │
│                                                      │
│ Recent:                                              │
│  ✓ Data Layer (18 triples)                          │
│  ✓ Redis Caching Strategy (12 triples)              │
│  ✗ Deployment Runbook (retry queued)                 │
│  ⟳ Microservices Architecture (extracting...)       │
│                                                      │
│ [Pause]  [Skip Current]  [Cancel Import]             │
└─────────────────────────────────────────────────────┘
```

### Step 4: Post-Processing

After all pages are extracted:

1. **Cross-page entity normalisation** — the existing `normalizeEntities()` runs across all extracted triples, deduplicating entities that different pages referred to differently.

2. **Hierarchy injection** — if "Preserve page hierarchy" was checked, emit:
   ```turtle
   kb:microservices  skos:broader  kb:architecture .
   kb:data-layer     skos:broader  kb:architecture .
   ```

3. **Label-to-type mapping** — Confluence labels become entity types:
   ```turtle
   kb:microservices  rdf:type  ktype:Architecture .
   kb:redis-caching  rdf:type  ktype:Infrastructure .
   ```

4. **Source provenance** — each page becomes a Source with Confluence metadata:
   ```typescript
   {
     kind: 'confluence',
     title: 'Microservices Architecture',
     uri: 'https://wiki.company.com/display/ENG/Microservices+Architecture',
     confluencePageId: '65602',
     confluenceSpaceKey: 'ENG',
     confluenceLabels: ['microservices', 'backend'],
   }
   ```

### Step 5: Review

All triples enter the review queue as `pending`. The user reviews in the standard Review page, but with confluence-aware filters:

- **Filter by source page** — "Show triples from 'Microservices Architecture' only"
- **Filter by Confluence label** — "Show all triples from pages labelled 'runbook'"
- **Bulk confirm by page** — "Confirm all 18 triples from 'Data Layer'"
- **Sort by confidence** — lowest confidence first for efficient review

---

## Scaling Considerations

### Memory Management

For large spaces (500+ pages), keeping all triples in memory during import is impractical. The pipeline should:

1. **Write each page's triples to IndexedDB immediately** after extraction (already done — `addStatements()` persists).
2. **Run normalisation in batches** — process 50 pages at a time through entity normalisation, then commit.
3. **Throttle the queue** — configurable delay between pages (default 600ms, same as current vault mode).

### Progress Persistence

If the browser tab closes mid-import:

```typescript
interface MigrationCheckpoint {
  id: string;
  spaceName: string;
  totalPages: number;
  completedPages: string[];  // Page IDs already processed
  failedPages: string[];     // Page IDs that errored
  startedAt: number;
  lastCheckpoint: number;
}
```

Store in `localStorage`. On page load, detect incomplete migration and offer to resume.

### Estimated Throughput

| Model | Pages/hour | Triples/hour | 500-page space |
|-------|-----------|-------------|----------------|
| `llama3.2:3b` | ~120 | ~1,800 | ~4 hours |
| `gemma3:4b` | ~90 | ~1,350 | ~5.5 hours |
| `gemma3:12b` | ~45 | ~675 | ~11 hours |
| `gemma3:27b` | ~20 | ~300 | ~25 hours |
| `Qwen2.5-0.5B` (WASM) | ~30 | ~450 | ~16 hours |
| Claude API | ~200 | ~3,000 | ~2.5 hours |

*Estimates assume average 3 chunks per page, 15 triples per page, consumer GPU (RTX 3060/4060).*

**Recommendation:** For spaces over 200 pages, run the import overnight with `gemma3:12b`. The pause/resume checkpoint system makes this practical.

---

## Implementation Phases

### Phase 1: Confluence Tab + HTML Parser (MVP)

- New `confluence` tab on the Add page
- ZIP upload and HTML parsing (extract text from `<div id="main-content">`)
- Page tree reconstruction from `index.html`
- Sequential extraction using existing `ingest()` pipeline
- Progress bar with page-level granularity

**Files to modify:**
- `src/routes/ingest/+page.svelte` — add confluence tab
- `src/lib/ingest/confluence-parse.ts` — new: HTML parser for Confluence exports

### Phase 2: Chunking + Queue

- `CHUNK_SIZE` / `CHUNK_OVERLAP` configurable
- Per-chunk extraction with deduplication
- Pause/resume with `localStorage` checkpoint
- Error retry queue (3 attempts per page)
- Estimated time calculation

**Files to modify:**
- `src/lib/integrations/llm/extractor.ts` — add `chunkText()` utility
- `src/lib/stores/ingest.svelte.ts` — add `ingestChunked()` variant

### Phase 3: Rename Ingest → Add

- Route: `/ingest` → `/add` (keep `/ingest` as redirect)
- NavBar label: `ingest` → `add`
- Tab labels: `vault` → `batch`
- Update all references in docs, TTL files, tests
- `SourceKind` add `'confluence'`

**Files to modify:**
- `src/routes/add/+page.svelte` — renamed from ingest
- `src/routes/ingest/+page.svelte` — redirect to /add
- `src/lib/components/NavBar.svelte` — label change
- `static/docs-features.ttl` — update feature entities
- `static/reckons-roadmap.ttl` — add feature entity

### Phase 4: Confluence API Connector (Optional)

- REST API client for Confluence Cloud
- Incremental sync (fetch pages modified since last import)
- Label and space metadata via API
- Requires user-provided API token

---

## Example: Before and After

### Confluence Page (HTML)

```html
<html>
<head><title>Redis Caching Strategy - Engineering Wiki</title></head>
<body>
<div id="main-content">
  <h1>Redis Caching Strategy</h1>
  <p>Our services use Redis 7.2 for caching with a TTL of 15 minutes
     for session data and 1 hour for configuration lookups.</p>
  <h2>Architecture</h2>
  <p>Redis runs as a 3-node cluster behind the payment service and
     the user service. The data layer reads from Redis before hitting
     PostgreSQL.</p>
  <h2>Failure Mode</h2>
  <p>If Redis is unavailable, services fall back to direct database
     queries. Latency increases from ~2ms to ~45ms.</p>
</div>
</body>
</html>
```

### Extracted Triples (from Ollama gemma3:12b)

```json
[
  {"subject": "redis-caching-strategy", "predicate": "uses-technology", "object": "redis", "confidence": 0.95},
  {"subject": "redis", "predicate": "has-version", "object": "7.2", "objectIsLiteral": true, "datatype": "string", "confidence": 0.9},
  {"subject": "redis", "predicate": "has-ttl-for", "object": "session-data", "confidence": 0.85, "gloss": "Redis uses a 15-minute TTL for session data."},
  {"subject": "redis", "predicate": "has-ttl-for", "object": "configuration-lookups", "confidence": 0.85},
  {"subject": "redis", "predicate": "deployed-as", "object": "3-node-cluster", "objectIsLiteral": true, "confidence": 0.9},
  {"subject": "payment-service", "predicate": "depends-on", "object": "redis", "confidence": 0.95},
  {"subject": "user-service", "predicate": "depends-on", "object": "redis", "confidence": 0.95},
  {"subject": "data-layer", "predicate": "reads-from", "object": "redis", "confidence": 0.9},
  {"subject": "data-layer", "predicate": "falls-back-to", "object": "postgresql", "confidence": 0.9},
  {"subject": "redis", "predicate": "has-failure-latency", "object": "~45ms", "objectIsLiteral": true, "confidence": 0.8}
]
```

### Resulting TTL (after review + confirm)

```turtle
kb:redis-caching-strategy  rdf:type        ktype:Infrastructure ;
                           rdfs:label      "Redis Caching Strategy" ;
                           kpred:uses-technology kb:redis .

kb:redis                   rdf:type        ktype:Tool ;
                           rdfs:label      "Redis" ;
                           kpred:has-version "7.2" ;
                           kpred:deployed-as "3-node-cluster" ;
                           kpred:has-failure-latency "~45ms" .

kb:payment-service         kpred:depends-on kb:redis .
kb:user-service            kpred:depends-on kb:redis .
kb:data-layer              kpred:reads-from kb:redis ;
                           kpred:falls-back-to kb:postgresql .
```

This becomes a navigable graph where clicking `redis` shows all services that depend on it, their failure modes, and the caching strategy — exactly the kind of cross-cutting view that's hard to find in Confluence's page-based navigation.
