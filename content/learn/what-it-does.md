---
title: "What it does"
slug: "what-it-does"
order: 2
section: "Learn"
template: doc
status: published
nav: sidebar
excerpt: "Every capability, and a worked example of each — what you can actually do with it."
generated: "docs-composed"
---

# What it does

Every capability, and a worked example of each — what you can actually do with it.

## Features

### 3D / 2D Knowledge Graph

Interactive force-directed graph in WebGL (3D) or Canvas (2D fallback). Per-entity icons from urn:kbase:predicate/icon2d statements with emoji fallback. Label overlap prevention sorts by degree and hides collisions. Hub emphasis, layout modes (force/focus/source/type/hub), filter chips.

### Compare / Diff Engine

Compare two knowledge graphs or snapshots at /compare. Diff engine categorizes changes as Add, Reinforce, Conflict, Merge, Remove. Visual Venn diagram and diff table with bulk accept/reject.

### Confluence Migration

Bulk import from Confluence spaces. Upload an HTML export ZIP, parse the page tree, chunk large pages with sliding window (10K chars, 2K overlap), and extract triples using local models (Ollama recommended). Preserves page hierarchy as skos:broader, converts Confluence labels to entity types, tracks provenance per page. Pause/resume checkpoint for overnight imports of large spaces.

### Content Safety

Ethics preamble injected into ALL LLM system prompts. Content classifier with two levels: blocked (filtered out on ingest) and mature (flagged on export with advisory). Discourse, disagreement, and academic content pass freely.

### Context Compression

Condense your context. Keep the meaning. Knowledge graphs are dense by nature — a page of prose becomes a handful of triples. Semantic meaning preserved, tokens reduced. Feed compressed graph directly to AI agents via MCP. Structured triples outperform summaries because no relationships are paraphrased away.

### Cross-Graph Alignment

Align entities across knowledge graphs. Entity matching via exact IRI match and embedding similarity. IRI remapping for entities that represent the same concept across graphs. Align tab in review page. KbPicker selects source graph, AlignmentCard shows each match with accept/reject.

### Currents

Streamed ingest: point a current at an RSS feed, URL, or topic and it brings recurring external content into your graph on a schedule. Items arrive via the n8n Currents Monitor (or a direct in-browser RSS fetch as fallback) and are ranked by affinity to your graph's most-connected entities, with near-duplicates collapsed and content-policy filtering applied. New facts always land as pending — a current never bypasses review. An entity-type gate (set in graph settings) restricts which types a current may CREATE; facts attaching to entities already in the graph always flow through. Configure currents and the type gate from the graph page.

### Diff Summary

LLM-generated 3-part summaries of diffs: what is new, what reinforces existing knowledge, and what conflicts. Integrated in /compare, /review, and the browser extension sidepanel.

### Disambiguation

Automatic detection of duplicate or similar entities using text embeddings and cosine similarity. Suggests merges for your review in the Merges tab.

### Entity Normalization

Post-extraction normalization that rewrites incoming IRIs to match existing graph entities and predicates using embedding similarity. Prevents duplicate entities like 'octopus-vulgaris' vs 'common-octopus' from entering the review queue. Two-pass matching: exact label (case-insensitive) then cosine similarity (0.90 entity, 0.88 predicate). Protected standard vocabularies (rdf:, rdfs:, skos:, xsd:) are never remapped.

### Entity Type System

Categorize entities (Person, Place, Concept, Tool, Document, Organization, Event) with custom colors and 3D shapes. Types assigned via rdf:type statements.

### Git Analysis

Git-aware MCP tools for agent plan alignment. Tools: kb_git_status (branch/commits), kb_check_plan (BM25 drift detection), kb_pending (review queue), kb_git_diff_triples (file-to-Graph cross-ref), kb_alignment_score (quantitative 0-1 score across 4 dimensions: coverage, status alignment, dependency respect, scope discipline). Enhanced kb_add_note supports type, priority, agent, and commit_sha metadata.

### Graph Identity

Each graph has a stable UUID (never changes, used for MCP routing and graph Leap) and a content fingerprint (SHA-256 of sorted N-Quads, changes with every edit). Both visible in Settings.

### Graph Leap

Cross-reference entities between graphs. A leap node stores a target (Graph stable ID, app path, or URL) as an ordinary RDF triple. Nodes with leaps show an amber ring. Click to jump to the target graph, navigate within the app, or open an external URL. Docs sub-graphs auto-import on first click.

### History Mode

Time-travel through your graph at /history. Scrub a timeline to see the graph at any past point. All mutations are logged in the changelog.

### Ingest

Add knowledge from text, URLs, documents, calendars, iCal feeds, Indico events, or Turtle files. An LLM extracts semantic triples from unstructured input. Every extracted triple starts as pending for your review.

### Kokoro TTS

Local text-to-speech for story walkthroughs. 82M model cached in browser. Falls back to browser speech synthesis if unavailable.

### LLM Backends

9 providers: Claude, OpenAI, Gemini, Ollama (local), OpenRouter (free tier), WASM (offline, Qwen2.5-0.5B-Instruct), Chrome AI (Gemini Nano), Manual paste, Mock. Per-task backend overrides let you use different providers for ingest, chat, analysis, diff summary, and merge analysis. Prefer-local routing can redirect chat, diff summary, and merge analysis to a reachable local Ollama server.

### MCP Workspace

Reckons.AI uses its own MCP server to track product state. Three internal graphs (Roadmap, Production, Features) are symlinked from static/*.ttl into mcp-workspace/kbs/. Claude Code queries these graphs before planning work. Edit a TTL file and the MCP server auto-reloads. Setup: bash scripts/setup-mcp-workspace.sh.

### Model Cache Management

Inspect, sideload, and purge locally cached WASM models. Manifests for Qwen2.5-0.5B (500MB), BGE-small-en-v1.5 (33MB), MiniLM-L6-v2 (22MB), Kokoro 82M (88MB), Whisper Tiny (42MB). Settings &gt; Integrations &gt; local model cache.

### Multi-Graph Management

Create, switch, rename, and delete independent knowledge graphs. Each graph has its own IndexedDB store, stable UUID, content fingerprint, and optional accent color. Per-tab graph support via URL ?kb= parameter.

### Passage Grounding

Verbatim source excerpts attached to extracted triples. LLM prompt rule requests the exact source sentence. Persists via meta:excerpt in TTL reification. Displayed in StatementCard and DiffEntry.

### Persona System

Each graph can embed its own AI assistant personality using the shelly: vocabulary. A work graph might have a direct, technical persona while a personal graph has a calm guide. Persona travels with the .ttl file.

### Pod View

Turn on the pod view from the Graph tab (currents section) to see arrivals -- nodes touched only by pending facts from a current -- drift gently at reduced opacity with a dashed halo, kept visually distinct until you accept or dismiss them from the node. Accept folds an arrival into the graph for normal review; dismiss clears it. It is a per-device view preference (stored locally, not in the graph) and is honoured by the home graph view.

### Predicate Manager

View all predicates in your graph with usage counts. Rename predicates across all statements or merge two predicates into one. Accessible from the graph page.

### Prefer-Local Routing

Opt-in setting that redirects chat, diff-summary, and merge-analysis to a local Ollama model whenever it is reachable, instead of your chosen cloud backend. Falls back to your normal backend chain the moment Ollama is unreachable -- no extraction quality is sacrificed silently. A companion structured-extraction mode uses a compact, schema-constrained prompt so small local models still produce clean facts.

### Published Graph Site

Any graph can publish itself as a browsable website. Entities typed as a web page export to markdown with frontmatter (title, section, order, excerpt) via the graph's structure -- skos:broader for parent/child, nav:order and nav:next/nav:prev for sequence. The generated site is served at /docs. The graph stays the source of truth: generated pages are regenerated from the graph, and hand-edits to them are overwritten by the next regeneration by design. A Git-backed admin UI edits non-generated content (like release posts); a drift check flags generated pages that no longer match their graph.

### Reckoning (STP)

Situation-Target-Proposal: describe your situation, state your goal, and the AI synthesizes options grounded ONLY in your confirmed triples. Every option cites its sources.

### Release Notes

Versioned release posts (starting with v0.1.0) authored as graph facts and published through the docs site, using the same web-page model as the rest of /docs.

### Review System

Three tabs: Incoming (new triples), Deletions (removal proposals), Merges (duplicate entity suggestions). Confirm, reject, or refine each statement. Nothing enters your graph without your approval.

### Review Workbench

The review page pairs its four tabs (incoming, deletions, merges, align) with a preview graph: browse controls step through items, a node-details + chat pane explains the selected fact in context, and clicking a review item flies the preview graph to its node with the relevant edge highlighted.

### Shelly (AI Assistant)

The turtle-shaped AI assistant. Three tabs: tutorial, chat (grounded in your graph), and explore (guided story tours). Each graph can embed its own Shelly persona via the shelly: vocabulary. Supports Whisper STT voice input and Kokoro TTS voice output.

### Source Monitoring

Watch URLs for content changes. The n8n Source Monitor workflow checks every 6 hours, detects diffs via content hash, and queues pending notes for review. Surfaces via /webhook/reckons-kb-pending endpoint.

### Source Refresh

Generic refresh for url, repository, and calendar sources. Auto-refresh on open and on interval (configurable). Graph page refresh button. MCP tools: kb_list_sources and kb_request_refresh. Delta comparison shows what changed since last ingest.

### Source Trust System

Sources accumulate trust scores based on your review decisions. Trusted sources can be auto-confirmed. A time-decay formula prevents stale trust from persisting.

### Story System

Guided walkthroughs defined as triples using the story: vocabulary. Steps can highlight entities, trigger prompts, and pose questions. Playback with countdown timer and TTS. Shareable via .ttl files.

### Text Chunking

Sliding window chunking for sources exceeding the 12K character extraction limit. Each chunk gets a context header (source title, chunk N of M, parent page). Cross-chunk deduplication merges triples with identical (subject, predicate, object) after slugification. Benefits all source types, not just Confluence.

### Turtle Export

Export your graph as a .ttl file with full reification metadata (status, source, confidence, timestamps, excerpts). Roundtrip-safe. Clean export for interop or full export with all metadata.

### Whisper STT

Local speech-to-text via transformers.js using whisper-tiny (42MB). Mic button in the chat tab. Runs entirely in-browser -- no cloud, no API key.

## Use cases

### Academic Research Group

A lab PI maintains a shared base graph of literature reviews, experimental parameters, and confirmed findings. PhD students import it and layer their own experiment results on top. When a student's results conflict with published work, a Reckoning cites papers by DOI and shared parameters to recommend framing -- novel finding or replication caveat. Other students can import each other's results and trace confidence levels through the full trust chain of sources.

### Collaborative Knowledge

One person organizes a graph around a shared topic, exports a .ttl file, and distributes it. Others import it as a source in their own graph. Each person uses Shelly and the Reckoning to ask questions relevant to them. Decisions are annotated with the sources that informed them. When things change, the organizer re-exports and importers see the diff in Compare.

See also: [Start here](/docs/learn/start-here)

### Corporate Pushback

When a company stonewalls, you need precision. Ingest their terms of service, your complaint history, regulatory requirements, and previous communications. Shelly can draft a response that cites chapter and verse from THEIR OWN documents.

### Decision Provenance

When a Reckoning produces a recommendation and the user accepts it, the resulting graph statements are automatically annotated with the source IRIs, Reckoning timestamp, and confidence level. Anyone reading the triple later can see it was added by a Reckoning on a specific date, informed by specific sources. The graph becomes self-documenting.

### Emergency Preparedness

A neighborhood coordinator maintains a graph of resource inventories, contact trees, shelter locations, and special-needs residents. Before severe weather, they re-ingest NWS alerts, run a Reckoning to match generator owners with power-dependent neighbors, and share the updated TTL. Each neighbor sees their assignment and the backing sources. The graph records resource allocation decisions with the weather warning as provenance.

### Employment Rights

Track your employment contract terms, company policies, HR correspondence, and performance records. When you need to assert your rights, your graph provides precise, documented, citable facts.

### Float Trip Planning

A group plans a weather-dependent river float trip. The organizer builds a graph with launch sites, shuttle logistics, and USGS river gauge data, then shares the TTL with participants. Each person asks Shelly their own questions -- schedule conflicts, gear needs, driving directions. As forecasts change, the organizer re-ingests weather sources, runs a Reckoning to confirm or adjust the launch time, and re-exports. Everyone sees the updated plan and the sources behind it.

### Import as Source with Update Detection

Treat an imported TTL file as a named source with a sharedBy field and content hash. When the original sharer re-exports, importers see a 'source updated' notification and route through Compare instead of direct merge. The importer accepts or rejects individual changes from the updated TTL, keeping their personal annotations intact.

### Insurance Claims

Ingest your policy documents, adjuster correspondence, photos, and repair estimates as triples. When you need to dispute a denial or request review, ask Shelly to draft a response citing specific policy clauses and documented evidence from your graph.

### Legal Disputes

Build a timeline of events, contracts, correspondence, and obligations. Your graph becomes a structured evidence base that you can query: 'What did the landlord promise regarding repairs, and when?' Every answer traces back to a source document.

### Medical Records

Organize diagnoses, prescriptions, test results, and doctor correspondence. Query your own medical history precisely. Prepare for appointments with a complete, structured record.

### Power to the Individual

Insurance companies have teams of analysts. Corporations have legal departments. Landlords have property managers. You have your memory and a stack of papers? Not anymore. Build a graph of your rights, evidence, and correspondence. Ask Shelly to draft a precise response citing YOUR documented facts. You communicate with the authority of an institution.

See also: [Start here](/docs/learn/start-here)

### Recurring Source Ingestion

Mark a URL source as recurring with a check interval. On each re-ingest, a new dated source record is created while the old record is kept for historical comparison. The Compare view shows what changed between ingestions. Enables live-data workflows like weather monitoring, river gauge tracking, and NWS alert subscriptions.

### Research and Academia

Track papers, authors, claims, contradictions. Build a literature review graph where every statement traces back to its source. Ask Shelly to summarize what you know about a topic -- every claim is cited.

### Residential Construction Project

A general contractor maintains a project graph with permits, schedules, and trade dependencies for a renovation. Subcontractors import the TTL to understand their scope and timing. When a change order arrives, the contractor ingests it, runs a Reckoning to assess schedule impact, and re-exports. Each trade asks Shelly their own questions -- 'What does CO-3 add to my scope?' -- without the GC being a bottleneck. Decisions trace back to the change order that triggered them.
