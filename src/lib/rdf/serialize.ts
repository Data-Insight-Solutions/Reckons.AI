import type { Statement, Source, Term, NamedNode } from './types';
import { isIRI, isLit, isBNode, termToString } from './types';
import { scanForExportAdvisory, exportAdvisoryHeader, exportAdvisoryTriple } from '../safety/content-policy';

/* ============================================================
 *  PREFIX REGISTRY
 *  Default prefixes used by the app. Users can extend.
 * ============================================================ */

export const DEFAULT_PREFIXES: Record<string, string> = {
  kb: 'urn:kbase:concept/',
  src: 'urn:kbase:source/',
  pred: 'urn:kbase:predicate/',
  meta: 'urn:kbase:meta/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  prov: 'http://www.w3.org/ns/prov#',
  dc: 'http://purl.org/dc/terms/'
};

/** Extended prefixes including annotation-specific ones for full export. */
export const FULL_PREFIXES: Record<string, string> = {
  ...DEFAULT_PREFIXES
};

/** Try to shorten an IRI using prefix table; otherwise return full `<iri>` */
function shorten(iri: string, prefixes: Record<string, string>): string {
  for (const [p, ns] of Object.entries(prefixes)) {
    if (iri.startsWith(ns)) {
      const local = iri.slice(ns.length);
      if (/^[A-Za-z_][\w\-.]*$/.test(local)) return `${p}:${local}`;
    }
  }
  return `<${iri}>`;
}

function termTTL(t: Term, prefixes: Record<string, string>): string {
  if (isIRI(t)) return shorten(t.value, prefixes);
  if (isBNode(t)) return `_:${t.value}`;
  if (isLit(t)) {
    const v = JSON.stringify(t.value);
    if (t.lang) return `${v}@${t.lang}`;
    if (t.datatype && t.datatype !== 'http://www.w3.org/2001/XMLSchema#string') {
      return `${v}^^${shorten(t.datatype, prefixes)}`;
    }
    return v;
  }
  return '';
}

/* ============================================================
 *  TURTLE EXPORT
 *  - Includes prefix header.
 *  - Groups by subject for readability.
 *  - Confirmed and refined statements only (configurable).
 *  - Provenance preserved via a separate `prov:wasDerivedFrom` block.
 * ============================================================ */

export type TurtleOptions = {
  includeStatuses?: Statement['status'][];
  includeProvenance?: boolean;
  prefixes?: Record<string, string>;
  header?: string;
};

export function toTurtle(statements: Statement[], opts: TurtleOptions = {}): string {
  const {
    includeStatuses = ['confirmed', 'refined'],
    includeProvenance = true,
    prefixes = DEFAULT_PREFIXES,
    header
  } = opts;

  const kept = statements.filter((s) => includeStatuses.includes(s.status));

  // Content advisory scan
  const advisory = scanForExportAdvisory(kept);
  const advisoryLines = exportAdvisoryHeader(advisory);

  const lines: string[] = [];
  if (header) lines.push(`# ${header}`);
  lines.push(`# generated ${new Date().toISOString()}`);
  lines.push(`# ${kept.length} statements`);
  if (advisoryLines.length > 0) lines.push(...advisoryLines);
  lines.push('');
  for (const [p, ns] of Object.entries(prefixes)) lines.push(`@prefix ${p}: <${ns}> .`);
  lines.push('');

  // Content advisory RDF triple
  const advisoryTriple = exportAdvisoryTriple(advisory);
  if (advisoryTriple) lines.push(advisoryTriple);

  // Group by subject for compact output
  const bySubject = new Map<string, Statement[]>();
  for (const st of kept) {
    const key = termTTL(st.s, prefixes);
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key)!.push(st);
  }

  for (const [subj, sts] of bySubject) {
    lines.push(`${subj}`);
    sts.forEach((st, i) => {
      const term = `    ${termTTL(st.p, prefixes)} ${termTTL(st.o, prefixes)}`;
      lines.push(term + (i === sts.length - 1 ? ' .' : ' ;'));
    });
    lines.push('');
  }

  if (includeProvenance) {
    lines.push('# ---- provenance ----');
    for (const st of kept) {
      lines.push(
        `<urn:kbase:stmt/${st.id}> prov:wasDerivedFrom ${termTTL(st.g, prefixes)} ;`
      );
      lines.push(`    dc:created "${new Date(st.createdAt).toISOString()}"^^xsd:dateTime .`);
    }
  }

  return lines.join('\n');
}

/* ============================================================
 *  N-QUADS EXPORT
 *  Canonical line-oriented format: one quad per line.
 *  Used for diff input and clipboard interchange.
 * ============================================================ */

export function toNQuads(statements: Statement[]): string {
  return statements
    .map((st) => `${termToString(st.s)} ${termToString(st.p)} ${termToString(st.o)} ${termToString(st.g)} .`)
    .join('\n');
}

/* ============================================================
 *  N-QUADS PARSE
 *  Minimal parser sufficient for round-tripping our own output.
 *  Full Turtle parsing is delegated to the N3 library when needed.
 * ============================================================ */

const RE_IRI = /<([^>]+)>/y;
const RE_BNODE = /_:([A-Za-z0-9]+)/y;
const RE_LIT = /"((?:[^"\\]|\\.)*)"(?:@([a-zA-Z\-]+)|\^\^<([^>]+)>)?/y;

function parseTerm(line: string, i: number): { term: Term; next: number } | null {
  RE_IRI.lastIndex = i;
  const mi = RE_IRI.exec(line);
  if (mi && mi.index === i) {
    return { term: { kind: 'iri', value: mi[1] }, next: i + mi[0].length };
  }
  RE_BNODE.lastIndex = i;
  const mb = RE_BNODE.exec(line);
  if (mb && mb.index === i) {
    return { term: { kind: 'bnode', value: mb[1] }, next: i + mb[0].length };
  }
  RE_LIT.lastIndex = i;
  const ml = RE_LIT.exec(line);
  if (ml && ml.index === i) {
    const value = ml[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return {
      term: { kind: 'literal', value, lang: ml[2], datatype: ml[3] },
      next: i + ml[0].length
    };
  }
  return null;
}

/* ============================================================
 *  FULL TURTLE EXPORT (annotated — all statuses)
 *  - Confirmed/refined triples appear as normal RDF triples.
 *  - Pending/rejected/superseded triples appear only in
 *    reification blocks (invisible to standard RDF tooling).
 *  - Source metadata and per-statement annotations (status,
 *    confidence, gloss) stored in meta: predicates.
 *  Round-trips via importTurtleFull() in import-ttl.ts.
 * ============================================================ */

export type ShellyPersonaExport = {
  // Identity & prompting
  name?: string;
  greeting?: string;
  personality?: string;
  systemPrompt?: string;
  responseStyle?: string;
  maxWords?: number;
  patienceLevel?: number;
  engagement?: string;
  // Voice
  voiceEnabled?: boolean;
  voiceType?: string;
  speechRate?: number;
  volume?: number;
  // Visual
  animationSpeed?: string;
  opacity?: number;
  size?: string;
  glowEffect?: boolean;
  wanderRange?: number;
  // Interaction
  proactiveHelp?: string;
  showTutorialHints?: boolean;
  responseFrequency?: number;
};

export function toTurtleFull(
  statements: Statement[],
  sources: Source[],
  opts: Pick<TurtleOptions, 'header' | 'prefixes'> & { shellyPersona?: ShellyPersonaExport; kbStableId?: string } = {}
): string {
  const prefixes = { ...FULL_PREFIXES, ...(opts.prefixes ?? {}) };

  // Content advisory scan
  const advisory = scanForExportAdvisory(statements);
  const advisoryLines = exportAdvisoryHeader(advisory);

  const lines: string[] = [];

  if (opts.header) lines.push(`# ${opts.header}`);
  lines.push(`# generated ${new Date().toISOString()}`);
  lines.push(`# ${statements.length} statements — full annotated export`);
  if (advisoryLines.length > 0) lines.push(...advisoryLines);
  lines.push('');
  for (const [p, ns] of Object.entries(prefixes)) lines.push(`@prefix ${p}: <${ns}> .`);
  if (opts.shellyPersona) lines.push('@prefix shelly: <urn:reckons:shelly/> .');
  lines.push('');

  // KB identity — stable ID embedded so imports can resolve KB Leap references
  if (opts.kbStableId) {
    lines.push('# ---- kb identity ----');
    lines.push(`<urn:reckons:kb> <urn:reckons:meta/kbStableId> "${opts.kbStableId}" .`);
    lines.push('');
  }

  // Content advisory RDF triple
  const advisoryTriple = exportAdvisoryTriple(advisory);
  if (advisoryTriple) {
    lines.push(advisoryTriple);
  }

  // 0. Shelly persona block (if configured beyond defaults)
  if (opts.shellyPersona) {
    const sp = opts.shellyPersona;
    const personaLines: string[] = [];
    // Identity & prompting
    if (sp.name) personaLines.push(`    shelly:name ${JSON.stringify(sp.name)}`);
    if (sp.greeting) personaLines.push(`    shelly:greeting ${JSON.stringify(sp.greeting)}`);
    if (sp.personality && sp.personality !== 'helpful') personaLines.push(`    shelly:personality "${sp.personality}"`);
    if (sp.systemPrompt) personaLines.push(`    shelly:systemPrompt ${JSON.stringify(sp.systemPrompt)}`);
    if (sp.responseStyle && sp.responseStyle !== 'concise') personaLines.push(`    shelly:responseStyle "${sp.responseStyle}"`);
    if (sp.maxWords && sp.maxWords > 0) personaLines.push(`    shelly:maxWords "${sp.maxWords}"`);
    if (sp.patienceLevel != null) personaLines.push(`    shelly:patienceLevel "${sp.patienceLevel}"`);
    if (sp.engagement && sp.engagement !== 'medium') personaLines.push(`    shelly:engagement "${sp.engagement}"`);
    // Voice
    if (sp.voiceEnabled != null) personaLines.push(`    shelly:voiceEnabled "${sp.voiceEnabled}"`);
    if (sp.voiceType && sp.voiceType !== 'tts') personaLines.push(`    shelly:voiceType "${sp.voiceType}"`);
    if (sp.speechRate != null && sp.speechRate !== 1) personaLines.push(`    shelly:speechRate "${sp.speechRate}"`);
    if (sp.volume != null && sp.volume !== 1) personaLines.push(`    shelly:volume "${sp.volume}"`);
    // Visual
    if (sp.animationSpeed && sp.animationSpeed !== 'normal') personaLines.push(`    shelly:animationSpeed "${sp.animationSpeed}"`);
    if (sp.opacity != null && sp.opacity !== 1) personaLines.push(`    shelly:opacity "${sp.opacity}"`);
    if (sp.size && sp.size !== 'medium') personaLines.push(`    shelly:size "${sp.size}"`);
    if (sp.glowEffect != null) personaLines.push(`    shelly:glowEffect "${sp.glowEffect}"`);
    if (sp.wanderRange != null && sp.wanderRange !== 50) personaLines.push(`    shelly:wanderRange "${sp.wanderRange}"`);
    // Interaction
    if (sp.proactiveHelp && sp.proactiveHelp !== 'errors-only') personaLines.push(`    shelly:proactiveHelp "${sp.proactiveHelp}"`);
    if (sp.showTutorialHints != null) personaLines.push(`    shelly:showTutorialHints "${sp.showTutorialHints}"`);
    if (sp.responseFrequency != null && sp.responseFrequency !== 0.5) personaLines.push(`    shelly:responseFrequency "${sp.responseFrequency}"`);
    if (personaLines.length > 0) {
      lines.push('# ---- turtle persona ----');
      lines.push('shelly:persona');
      personaLines.forEach((l, i) => lines.push(l + (i === personaLines.length - 1 ? ' .' : ' ;')));
      lines.push('');
    }
  }

  // 1. Direct triples for confirmed/refined only (clean RDF graph)
  const confirmed = statements.filter(s => s.status === 'confirmed' || s.status === 'refined');
  if (confirmed.length > 0) {
    lines.push('# ---- confirmed graph ----');
    const bySubject = new Map<string, Statement[]>();
    for (const st of confirmed) {
      const key = termTTL(st.s, prefixes);
      if (!bySubject.has(key)) bySubject.set(key, []);
      bySubject.get(key)!.push(st);
    }
    for (const [subj, sts] of bySubject) {
      lines.push(subj);
      sts.forEach((st, i) => {
        const term = `    ${termTTL(st.p, prefixes)} ${termTTL(st.o, prefixes)}`;
        lines.push(term + (i === sts.length - 1 ? ' .' : ' ;'));
      });
      lines.push('');
    }
  }

  // 2. Source metadata blocks
  if (sources.length > 0) {
    lines.push('# ---- sources ----');
    for (const src of sources) {
      const srcIri = shorten(`urn:kbase:source/${src.id}`, prefixes);
      lines.push(srcIri);
      lines.push(`    rdf:type meta:Source ;`);
      lines.push(`    dc:title ${JSON.stringify(src.title)} ;`);
      lines.push(`    meta:sourceUri ${JSON.stringify(src.uri)} ;`);
      lines.push(`    meta:sourceKind "${src.kind}" ;`);
      if (src.trustLevel) lines.push(`    meta:trustLevel "${src.trustLevel}" ;`);
      if (src.trustScore != null) lines.push(`    meta:trustScore "${src.trustScore}"^^xsd:decimal ;`);
      lines.push(`    dc:created "${new Date(src.ingestedAt).toISOString()}"^^xsd:dateTime .`);
      lines.push('');
    }
  }

  // 3. Reification blocks for ALL statements (carries status + full metadata)
  lines.push('# ---- statement metadata (all statuses) ----');
  for (const st of statements) {
    lines.push(`<urn:kbase:stmt/${st.id}>`);
    lines.push(`    rdf:type rdf:Statement ;`);
    lines.push(`    rdf:subject ${termTTL(st.s, prefixes)} ;`);
    lines.push(`    rdf:predicate ${termTTL(st.p, prefixes)} ;`);
    lines.push(`    rdf:object ${termTTL(st.o, prefixes)} ;`);
    lines.push(`    meta:status "${st.status}" ;`);
    lines.push(`    meta:confidence "${st.confidence}"^^xsd:decimal ;`);
    if (st.gloss) lines.push(`    meta:gloss ${JSON.stringify(st.gloss)} ;`);
    if (st.excerpt) lines.push(`    meta:excerpt ${JSON.stringify(st.excerpt)} ;`);
    if (st.supersedes) lines.push(`    meta:supersedes <urn:kbase:stmt/${st.supersedes}> ;`);
    lines.push(`    prov:wasDerivedFrom ${termTTL(st.g, prefixes)} ;`);
    lines.push(`    dc:created "${new Date(st.createdAt).toISOString()}"^^xsd:dateTime .`);
    lines.push('');
  }

  return lines.join('\n');
}

export function parseNQuads(text: string): Array<{
  s: Term;
  p: NamedNode;
  o: Term;
  g: NamedNode;
}> {
  const out: Array<{ s: Term; p: NamedNode; o: Term; g: NamedNode }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let i = 0;
    const skip = () => {
      while (i < line.length && /\s/.test(line[i])) i++;
    };
    skip();
    const s = parseTerm(line, i);
    if (!s) continue;
    i = s.next;
    skip();
    const p = parseTerm(line, i);
    if (!p || p.term.kind !== 'iri') continue;
    i = p.next;
    skip();
    const o = parseTerm(line, i);
    if (!o) continue;
    i = o.next;
    skip();
    const g = parseTerm(line, i);
    if (!g || g.term.kind !== 'iri') continue;
    out.push({ s: s.term, p: p.term, o: o.term, g: g.term });
  }
  return out;
}
