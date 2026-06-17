# Model Training — Planning Document

> Status: **Planning** | Feature: F13

## Goal

Allow users to fine-tune a local model on their KB data, producing a personalized
assistant that reasons natively over their domain vocabulary and relationships.

## Target Models

| Model | Size | Runtime | Notes |
|-------|------|---------|-------|
| Granite 3.1 2B | 2B | ONNX/WASM | IBM open-source, instruction-tuned, Apache 2.0 |
| SmolLM2-360M | 360M | transformers.js | Already used as WASM fallback |
| Phi-3-mini | 3.8B | ONNX | Microsoft, MIT license |

Granite and Phi are the most promising for personalization — small enough to fine-tune
on consumer hardware, large enough to be useful.

## Training Data Pipeline

### 1. KB → Training Pairs

The KB triples are converted into instruction-tuning pairs:

```
Triple: alice .worksAt acme-corp
→ { "instruction": "Where does Alice work?", "response": "Alice works at Acme Corp." }

Triple: projectX .hasStatus delayed; .reason supply-chain
→ { "instruction": "What is Project X's status?",
    "response": "Project X is delayed due to supply chain issues." }
```

**Generation strategies:**
- **Entity QA:** For each entity, generate questions about its properties
- **Relationship QA:** For connected entities, generate questions about relationships
- **Reasoning:** For multi-hop paths, generate inference questions
- **Summarization:** For entity subgraphs, generate summaries

### 2. Augmentation

- Generate paraphrases of questions (multiple phrasings)
- Add negative examples ("What is Alice's hobby?" → "The KB doesn't contain information about Alice's hobbies.")
- Include retrieval-augmented examples (question + relevant triples → answer)

### 3. Export Formats

- **JSONL** (instruction/response pairs) — standard for fine-tuning
- **Alpaca format** — instruction/input/output
- **ShareGPT format** — multi-turn conversations

## Architecture Options

### Option A: Cloud Fine-Tuning (Phase 1)

Export training data → user uploads to:
- AWS Bedrock (Granite, custom models)
- Together.ai / Fireworks (open models)
- Hugging Face AutoTrain

Reckons.AI generates and exports the JSONL; user handles the training externally.

**Pros:** No local GPU needed, production-quality training
**Cons:** Data leaves the device, requires cloud account + cost

### Option B: Local Fine-Tuning via LoRA (Phase 2)

Use a lightweight LoRA adapter approach:
1. Base model: SmolLM2-360M (already cached locally)
2. Generate LoRA adapter weights from KB data
3. Merge or load adapter at inference time

**Implementation:**
- Training could use WebGPU (experimental) or a local Python sidecar
- Adapter files are small (10-50MB) and portable
- Multiple KB adapters can coexist with one base model

**Pros:** Data stays local, no cloud costs
**Cons:** Requires GPU or long CPU training time, quality limited by base model size

### Option C: Retrieval-Augmented Only (Baseline)

Skip fine-tuning entirely — improve RAG quality instead:
- Better BM25 + semantic search (embedding similarity)
- Smarter context window construction
- Entity-aware chunking

This is what we do today. Fine-tuning complements it; doesn't replace it.

## Proposed UI

### Settings > Training

```
┌─ Model Training ─────────────────────────────────────────┐
│                                                          │
│  Training Data                                           │
│  ┌─────────────────────────────────────────────────┐     │
│  │ 847 triples → ~2,500 training pairs             │     │
│  │ [Generate Training Data]  [Preview]  [Export]    │     │
│  └─────────────────────────────────────────────────┘     │
│                                                          │
│  Target Model: [Granite 3.1 2B ▾]                        │
│  Format:       [JSONL ▾]                                 │
│                                                          │
│  Cloud Training                                          │
│  [Export for Bedrock]  [Export for Together.ai]           │
│                                                          │
│  Local Training (experimental)                           │
│  [Train LoRA Adapter]  Status: not started               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### KB Page Section

Add a "Training" section under the KB page showing:
- Last training data generation date
- Number of training pairs
- Quick export button

## Implementation Phases

### Phase 1: Training Data Generation + Export
- `src/lib/training/generate-pairs.ts` — triple → QA pair generation
- `src/lib/training/export.ts` — JSONL/Alpaca/ShareGPT formatters
- UI in Settings > Training tab
- CLI command: `reckons export-training --format jsonl`
- MCP tool: `kb_export_training`

### Phase 2: Cloud Integration
- Bedrock export with proper IAM setup guide
- Together.ai API integration for one-click fine-tuning
- Model download back to local cache

### Phase 3: Local LoRA Training
- WebGPU-accelerated LoRA training (when browser support matures)
- Python sidecar fallback (`reckons train --local`)
- Adapter management (load/unload per KB)

## Open Questions

1. **Quality threshold:** How many triples are needed for useful fine-tuning? Likely 200+ for meaningful results.
2. **Evaluation:** How do we measure if the fine-tuned model is better than RAG alone? Need a KB-specific eval set.
3. **Incremental training:** Can we update the adapter when new triples are added without full retraining?
4. **Multi-KB:** Should adapters be per-KB or trained on all user KBs combined?
