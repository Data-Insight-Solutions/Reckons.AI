import { describe, it, expect } from 'vitest';
import {
  iri, lit, bnode,
  isIRI, isLit, isBNode,
  termToString, termKey, tripleKey, quadKey,
  isMetaPredicate,
  PREDICATE_PREFIX, META_PREFIX, NAV_PREFIX,
} from '../types';

// ── Term constructors ────────────────────────────────────────────────────────

describe('term constructors', () => {
  it('iri() creates a NamedNode', () => {
    const t = iri('urn:example/a');
    expect(t.kind).toBe('iri');
    expect(t.value).toBe('urn:example/a');
  });

  it('lit() creates a Literal with optional datatype', () => {
    const t = lit('hello', 'http://www.w3.org/2001/XMLSchema#string');
    expect(t.kind).toBe('literal');
    expect(t.value).toBe('hello');
    expect(t.datatype).toBe('http://www.w3.org/2001/XMLSchema#string');
  });

  it('lit() creates a Literal with optional lang', () => {
    const t = lit('bonjour', undefined, 'fr');
    expect(t.kind).toBe('literal');
    expect(t.lang).toBe('fr');
    expect(t.datatype).toBeUndefined();
  });

  it('bnode() creates a BlankNode', () => {
    const t = bnode('b0');
    expect(t.kind).toBe('bnode');
    expect(t.value).toBe('b0');
  });
});

// ── Type guards ──────────────────────────────────────────────────────────────

describe('type guards', () => {
  it('isIRI identifies NamedNode', () => {
    expect(isIRI(iri('urn:x'))).toBe(true);
    expect(isIRI(lit('x'))).toBe(false);
    expect(isIRI(bnode('b'))).toBe(false);
  });

  it('isLit identifies Literal', () => {
    expect(isLit(lit('x'))).toBe(true);
    expect(isLit(iri('urn:x'))).toBe(false);
  });

  it('isBNode identifies BlankNode', () => {
    expect(isBNode(bnode('b'))).toBe(true);
    expect(isBNode(iri('urn:x'))).toBe(false);
  });
});

// ── termToString ─────────────────────────────────────────────────────────────

describe('termToString', () => {
  it('wraps IRIs in angle brackets', () => {
    expect(termToString(iri('urn:example/foo'))).toBe('<urn:example/foo>');
  });

  it('renders literals as JSON strings', () => {
    expect(termToString(lit('hello'))).toBe('"hello"');
  });

  it('appends language tag', () => {
    expect(termToString(lit('bonjour', undefined, 'fr'))).toBe('"bonjour"@fr');
  });

  it('appends non-string datatype', () => {
    const t = lit('42', 'http://www.w3.org/2001/XMLSchema#integer');
    expect(termToString(t)).toBe('"42"^^<http://www.w3.org/2001/XMLSchema#integer>');
  });

  it('omits xsd:string datatype', () => {
    const t = lit('plain', 'http://www.w3.org/2001/XMLSchema#string');
    expect(termToString(t)).toBe('"plain"');
  });

  it('renders blank nodes with _: prefix', () => {
    expect(termToString(bnode('b0'))).toBe('_:b0');
  });
});

// ── termKey ──────────────────────────────────────────────────────────────────

describe('termKey', () => {
  it('prefixes IRI keys with i:', () => {
    expect(termKey(iri('urn:x'))).toBe('i:urn:x');
  });

  it('prefixes bnode keys with b:', () => {
    expect(termKey(bnode('b0'))).toBe('b:b0');
  });

  it('prefixes literal keys with l: and includes datatype/lang', () => {
    const key = termKey(lit('hello', 'xsd:string', 'en'));
    expect(key).toBe('l:hello|xsd:string|en');
  });

  it('uses empty strings for missing datatype/lang', () => {
    const key = termKey(lit('hello'));
    expect(key).toBe('l:hello||');
  });

  it('produces different keys for different datatypes', () => {
    const k1 = termKey(lit('42', 'xsd:integer'));
    const k2 = termKey(lit('42', 'xsd:string'));
    expect(k1).not.toBe(k2);
  });
});

// ── tripleKey / quadKey ──────────────────────────────────────────────────────

describe('tripleKey', () => {
  it('combines s, p, o keys with > separator', () => {
    const key = tripleKey({
      s: iri('urn:s'),
      p: iri('urn:p'),
      o: lit('val'),
    });
    expect(key).toBe('i:urn:s>i:urn:p>l:val||');
  });

  it('produces different keys for different triples', () => {
    const k1 = tripleKey({ s: iri('urn:a'), p: iri('urn:p'), o: iri('urn:b') });
    const k2 = tripleKey({ s: iri('urn:a'), p: iri('urn:p'), o: iri('urn:c') });
    expect(k1).not.toBe(k2);
  });
});

describe('quadKey', () => {
  it('extends tripleKey with graph component', () => {
    const key = quadKey({
      s: iri('urn:s'),
      p: iri('urn:p'),
      o: iri('urn:o'),
      g: iri('urn:g'),
    });
    expect(key).toBe('i:urn:s>i:urn:p>i:urn:o>i:urn:g');
  });

  it('different graphs produce different quad keys', () => {
    const base = { s: iri('urn:s'), p: iri('urn:p'), o: iri('urn:o') };
    const k1 = quadKey({ ...base, g: iri('urn:g1') });
    const k2 = quadKey({ ...base, g: iri('urn:g2') });
    expect(k1).not.toBe(k2);
  });
});

// ── isMetaPredicate ──────────────────────────────────────────────────────────

describe('isMetaPredicate', () => {
  it('returns true for urn:kbase:meta/* predicates', () => {
    expect(isMetaPredicate('urn:kbase:meta/kbStableId')).toBe(true);
    expect(isMetaPredicate('urn:kbase:meta/glbModel')).toBe(true);
  });

  it('returns true for nav:order', () => {
    expect(isMetaPredicate('urn:reckons:nav/order')).toBe(true);
  });

  it('returns true for nav:layer', () => {
    expect(isMetaPredicate('urn:reckons:nav/layer')).toBe(true);
  });

  it('returns false for nav:next (visible edge)', () => {
    expect(isMetaPredicate('urn:reckons:nav/next')).toBe(false);
  });

  it('returns false for nav:prev (visible edge)', () => {
    expect(isMetaPredicate('urn:reckons:nav/prev')).toBe(false);
  });

  it('returns false for regular predicates', () => {
    expect(isMetaPredicate('urn:kbase:predicate/knows')).toBe(false);
    expect(isMetaPredicate('http://www.w3.org/2004/02/skos/core#related')).toBe(false);
  });

  it('returns false for rdf:type', () => {
    expect(isMetaPredicate('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')).toBe(false);
  });
});

// ── Namespace constants ──────────────────────────────────────────────────────

describe('namespace constants', () => {
  it('PREDICATE_PREFIX is correct', () => {
    expect(PREDICATE_PREFIX).toBe('urn:kbase:predicate/');
  });

  it('META_PREFIX is correct', () => {
    expect(META_PREFIX).toBe('urn:kbase:meta/');
  });

  it('NAV_PREFIX is correct', () => {
    expect(NAV_PREFIX).toBe('urn:reckons:nav/');
  });
});
