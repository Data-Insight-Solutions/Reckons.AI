import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { Parser } from 'n3';
import { EXAMPLE_KBS, listedExampleKbs, findExampleKb } from '../example-kbs';

describe('example entries (F292.3)', () => {
  it('the ring is unlisted: resolvable by id, absent from the list', () => {
    expect(findExampleKb('ring-scan')?.file).toBe('/starter-ring-scan.ttl');
    expect(listedExampleKbs().some((k) => k.id === 'ring-scan')).toBe(false);
    expect(listedExampleKbs().length).toBe(EXAMPLE_KBS.length - 4);
    for (const id of ['review-0.2.6', 'review-0.2.7', 'review-0.2.8']) {
      expect(findExampleKb(id)).toBeDefined();
      expect(listedExampleKbs().some((k) => k.id === id)).toBe(false);
    }
    expect(findExampleKb(null)).toBeUndefined();
  });

  it('every entry points at a real file and its counts match the file', () => {
    for (const kb of EXAMPLE_KBS) {
      const path = `static${kb.file}`;
      expect(existsSync(path), path).toBe(true);
    }
    const ring = findExampleKb('ring-scan')!;
    const quads: any[] = new Parser().parse(readFileSync(`static${ring.file}`, 'utf8'));
    expect(quads.length).toBe(ring.triples);
    expect(new Set(quads.map((q) => q.subject.value)).size).toBe(ring.entities);
  });

  it('the Data Insight Solutions example: its counts match the file (entities with facts, facts), and it names a person', () => {
    const kb = findExampleKb('data-insight-solutions')!;
    const quads: any[] = new Parser().parse(readFileSync(`static${kb.file}`, 'utf8'));
    const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
    const facts = quads.filter((q) => q.predicate.value === RDF + 'type' && q.object.value === RDF + 'Statement');
    const subjects = new Set(quads.filter((q) => q.predicate.value === RDF + 'subject').map((q) => q.object.value));
    expect(facts.length).toBe(kb.triples);
    expect(subjects.size).toBe(kb.entities);
    expect(quads.some((q) => q.predicate.value === RDF + 'type' && q.object.value === 'urn:kbase:type/Person')).toBe(true);
  });

  it('the ring splat is reconstructed, exists, and is a story of ten ordered steps that resolve', () => {
    const quads: any[] = new Parser().parse(readFileSync('static/starter-ring-scan.ttl', 'utf8'));
    const splat = quads.find((q: any) => q.predicate.value === 'urn:kbase:predicate/splat')!;
    expect(existsSync(`static${splat.object.value}`)).toBe(true);
    const origin = quads.find((q) => q.subject.value === splat.subject.value && q.predicate.value === 'urn:kbase:meta/splat-origin');
    expect(origin?.object.value).toBe('reconstructed');
    const subjects = new Set(quads.map((q) => q.subject.value));
    const steps: string[] = quads.filter((q) => q.predicate.value === 'urn:reckons:story/partOf').map((q) => q.subject.value);
    expect(steps.length).toBe(10);
    const orders = steps.map((s: string) => Number(quads.find((q) => q.subject.value === s && q.predicate.value === 'urn:reckons:story/order')!.object.value)).sort((a: number, b: number) => a - b);
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const q of quads.filter((q) => q.predicate.value === 'urn:reckons:story/highlight')) expect(subjects.has(q.object.value)).toBe(true);
  });

  it('every published ring media file exists and is small (video, frames)', () => {
    const quads: any[] = new Parser().parse(readFileSync('static/starter-ring-scan.ttl', 'utf8'));
    const media = quads.filter((q) => ['urn:kbase:predicate/video', 'urn:kbase:predicate/photo'].includes(q.predicate.value));
    expect(media.length).toBe(12);
    for (const q of media) {
      expect(existsSync(`static${q.object.value}`), q.object.value).toBe(true);
      expect(statSync(`static${q.object.value}`).size).toBeLessThan(3 * 1024 * 1024);
    }
  });
});
