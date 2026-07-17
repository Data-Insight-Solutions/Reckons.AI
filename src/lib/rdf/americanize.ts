/**
 * Deterministic British → American spelling normalization for Turtle text.
 *
 * Pure (no fs) so it can be unit-tested and reused. `sweepLiterals` rewrites
 * British spellings ONLY inside Turtle string literals — never inside IRIs,
 * prefixed names, `@prefix` lines, or datatype/lang tags — so it can't rename an
 * entity and break a cross-reference. `scanIdentifiers` reports (but never
 * changes) prefixed names / IRI local-names that carry a British spelling, for
 * manual review.
 *
 * Used by scripts/americanize-ttl.ts.
 */

/** Expand a regular British "-ise" verb into its American "-ize" inflections. */
export function iseFamily(brIse: string): [string, string][] {
  const stem = brIse.replace(/ise$/, '');
  const br = ['ise', 'ised', 'ises', 'ising', 'isation', 'isations', 'isational', 'iser', 'isers'];
  const us = ['ize', 'ized', 'izes', 'izing', 'ization', 'izations', 'izational', 'izer', 'izers'];
  return br.map((s, i) => [stem + s, stem + us[i]] as [string, string]);
}

export const ISE_VERBS = [
  'normalise', 'serialise', 'organise', 'summarise', 'optimise', 'visualise',
  'prioritise', 'deprioritise', 'recognise', 'categorise', 'minimise', 'maximise',
  'standardise', 'synchronise', 'customise', 'generalise', 'specialise', 'realise',
  'initialise', 'emphasise', 'utilise', 'centralise', 'decentralise', 'characterise',
  'personalise', 'authorise', 'modularise', 'parameterise',
];

/** Irregulars that don't follow the -ise → -ize rule. */
export const IRREGULAR: [string, string][] = [
  ['analyse', 'analyze'], ['analysed', 'analyzed'], ['analyses', 'analyzes'], ['analysing', 'analyzing'],
  ['colour', 'color'], ['colours', 'colors'], ['coloured', 'colored'], ['colouring', 'coloring'], ['colourful', 'colorful'],
  ['behaviour', 'behavior'], ['behaviours', 'behaviors'], ['behavioural', 'behavioral'],
  ['neighbour', 'neighbor'], ['neighbours', 'neighbors'], ['neighbourhood', 'neighborhood'], ['neighbouring', 'neighboring'],
  ['centre', 'center'], ['centres', 'centers'], ['centred', 'centered'], ['centring', 'centering'],
  ['licence', 'license'], ['licences', 'licenses'],
  ['catalogue', 'catalog'], ['catalogues', 'catalogs'], ['catalogued', 'cataloged'],
  ['defence', 'defense'], ['offence', 'offense'],
  ['favour', 'favor'], ['favours', 'favors'], ['favoured', 'favored'], ['favouring', 'favoring'],
  ['favourite', 'favorite'], ['favourites', 'favorites'], ['favourable', 'favorable'],
  ['grey', 'gray'],
  ['fibre', 'fiber'], ['fibres', 'fibers'], ['metre', 'meter'], ['metres', 'meters'], ['litre', 'liter'], ['litres', 'liters'],
  ['programme', 'program'], ['programmes', 'programs'],
  ['cancelled', 'canceled'], ['cancelling', 'canceling'],
  ['modelling', 'modeling'], ['modelled', 'modeled'],
  ['labelling', 'labeling'], ['labelled', 'labeled'],
  ['travelled', 'traveled'], ['travelling', 'traveling'],
  ['dialogue', 'dialog'], ['dialogues', 'dialogs'],
];

/** British → American map, longest-first so \b-anchored matches don't collide. */
export const SPELLING_MAP: [string, string][] = [...ISE_VERBS.flatMap(iseFamily), ...IRREGULAR]
  .filter(([a, b]) => a !== b)
  .sort((a, b) => b[0].length - a[0].length);

const BRITISH_WORDS = new Set(SPELLING_MAP.map(([a]) => a.toLowerCase()));
const REPLACERS = SPELLING_MAP.map(([br, us]) => ({ re: new RegExp(`\\b${br}\\b`, 'gi'), us }));

/** Copy the case pattern of `src` onto `repl` (all-caps / Titlecase / lower). */
export function applyCase(src: string, repl: string): string {
  if (src === src.toUpperCase()) return repl.toUpperCase();
  if (src[0] === src[0].toUpperCase()) return repl[0].toUpperCase() + repl.slice(1);
  return repl;
}

/** Americanize free text (case-preserving). Count is the number of replacements. */
export function americanizeText(text: string): { out: string; count: number } {
  let out = text;
  let count = 0;
  for (const { re, us } of REPLACERS) {
    out = out.replace(re, (m) => { count++; return applyCase(m, us); });
  }
  return { out, count };
}

/**
 * Find the [start, end) spans of every Turtle string literal, correctly
 * ignoring `"` that appears inside `#` comments or `<…>` IRIs. A naive regex
 * miscounts a stray quote in a comment and desyncs every literal after it, so
 * we walk the text with a small state machine instead.
 */
export function literalSpans(ttl: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const n = ttl.length;
  let i = 0;
  while (i < n) {
    const c = ttl[i];
    if (c === '#') { // comment to end of line
      while (i < n && ttl[i] !== '\n') i++;
      continue;
    }
    if (c === '<') { // IRI ref — skip to '>'
      i++;
      while (i < n && ttl[i] !== '>' && ttl[i] !== '\n') i++;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = ttl.substr(i, 3) === c + c + c;
      const start = i;
      if (triple) {
        i += 3;
        while (i < n && ttl.substr(i, 3) !== c + c + c) { if (ttl[i] === '\\') i++; i++; }
        i += 3;
      } else {
        i++;
        while (i < n && ttl[i] !== c && ttl[i] !== '\n') { if (ttl[i] === '\\') i++; i++; }
        i++;
      }
      spans.push([start, Math.min(i, n)]);
      continue;
    }
    i++;
  }
  return spans;
}

/** Rewrite British spellings only inside string literals; IRIs untouched. */
export function sweepLiterals(ttl: string): { out: string; count: number } {
  const spans = literalSpans(ttl);
  let out = '';
  let last = 0;
  let count = 0;
  for (const [s, e] of spans) {
    out += ttl.slice(last, s);
    const r = americanizeText(ttl.slice(s, e));
    out += r.out;
    count += r.count;
    last = e;
  }
  out += ttl.slice(last);
  return { out, count };
}

/** Prefixed names / IRI local-names carrying a British spelling (NOT rewritten). */
export function scanIdentifiers(ttl: string): string[] {
  // Blank out literal spans so we only inspect IRIs / prefixed names.
  let stripped = ttl;
  for (const [s, e] of literalSpans(ttl).reverse()) {
    stripped = stripped.slice(0, s) + '""' + stripped.slice(e);
  }
  const hits = new Set<string>();
  const tokenRe = /[A-Za-z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9_-]*|<[^>]+>/g;
  for (const tok of stripped.match(tokenRe) ?? []) {
    const parts = tok.replace(/[<>]/g, '').split(/[/#:_\-]|(?=[A-Z])/);
    for (const part of parts) {
      if (BRITISH_WORDS.has(part.toLowerCase())) { hits.add(tok); break; }
    }
  }
  return [...hits];
}
