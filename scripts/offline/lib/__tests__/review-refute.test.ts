import { describe, it, expect } from 'vitest';
import { importLineOf, missingImportName, refuteFinding } from '../review-refute';

// The two findings below are the real wording qwen3-coder produced on 2026-10-06 (no personal data).
const MISSING_IMPORT = "src/routes/(app)/+page.svelte:26 — Missing import of `buildProvenanceIndex` in the component's script context, which may cause runtime errors if not properly exported or available in scope.";
const DUPLICATE_TTL = 'static/reckons-terminology.ttl:260 — Duplicate skos:scopeNote property; second definition overrides first, potentially losing intended documentation';

const svelte = [
  '<script lang="ts">',
  "  import { onMount } from 'svelte';",
  '  import {',
  '    buildProvenanceIndex,',
  '    createProvenanceControls, type projectProvenance,',
  "  } from '$lib/rdf/provenance-view';",
  "  import * as kb from '$lib/kb';",
  "  import Card, { variants as cardVariants } from './Card.svelte';",
  '</script>',
].join('\n');

describe('missingImportName', () => {
  it('reads the identifier from the observed wording and close variants', () => {
    expect(missingImportName(MISSING_IMPORT)).toBe('buildProvenanceIndex');
    expect(missingImportName('x.ts:3 — `foo` is not imported')).toBe('foo');
    expect(missingImportName('x.ts:3 — missing import for bar, breaks build')).toBe('bar');
    expect(missingImportName('x.ts:3 — off-by-one in the loop bound')).toBeNull();
  });
});

describe('importLineOf', () => {
  it('finds named, multi-line, type, namespace, default and aliased bindings', () => {
    expect(importLineOf(svelte, 'onMount')).toBe(2);
    expect(importLineOf(svelte, 'buildProvenanceIndex')).toBe(3);
    expect(importLineOf(svelte, 'projectProvenance')).toBe(3);
    expect(importLineOf(svelte, 'kb')).toBe(7);
    expect(importLineOf(svelte, 'Card')).toBe(8);
    expect(importLineOf(svelte, 'cardVariants')).toBe(8);
  });

  it('does not count an alias source name or a mere mention as a binding', () => {
    expect(importLineOf(svelte, 'variants')).toBeNull();
    expect(importLineOf(svelte + '\nbuildThing();', 'buildThing')).toBeNull();
  });
});

describe('refuteFinding', () => {
  it('refutes a missing-import claim when the file binds the name, and says where', () => {
    expect(refuteFinding('src/routes/(app)/+page.svelte', MISSING_IMPORT, svelte))
      .toEqual({ rule: 'imported', reason: 'buildProvenanceIndex is imported at line 3' });
  });

  it('keeps a missing-import claim the file does not disprove', () => {
    expect(refuteFinding('a.ts', MISSING_IMPORT, "import { other } from './x';")).toBeNull();
    // No readable source (deleted or unreadable file): never refute blind.
    expect(refuteFinding('a.ts', MISSING_IMPORT, null)).toBeNull();
  });

  it('refutes "duplicate predicate overrides" on Turtle only', () => {
    expect(refuteFinding('static/reckons-terminology.ttl', DUPLICATE_TTL, null)?.rule).toBe('rdf-repeatable');
    expect(refuteFinding('src/config.ts', DUPLICATE_TTL, '')).toBeNull();
  });

  it('leaves other Turtle findings alone', () => {
    expect(refuteFinding('static/x.ttl', 'static/x.ttl:12 — prefix kpred: is used but never declared', null)).toBeNull();
    expect(refuteFinding('static/x.ttl', 'static/x.ttl:9 — status changed to in-progress without evidence', null)).toBeNull();
  });
});
