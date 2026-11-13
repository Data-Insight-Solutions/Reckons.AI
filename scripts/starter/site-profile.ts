/**
 * Reads the PUBLISHED structure of a site's About and Services pages into plain records (F274.7).
 *
 * Deterministic and pure: no model, no clock, no file access. It follows the structure the markdown already has, not
 * free text: `##` sections with their `@id:` directives, `###` sub-sections, list entries, `**Label:**` group lines,
 * `[text](href)` links, the `==highlight==` marks and the `| valid-until:` marker. Anything that does not match its
 * expected shape is LEFT OUT, never guessed; `skipped` names each one so the caller can see what the pages state that
 * the example does not carry. The text a record carries is the page's own words, one sentence or one list entry at a
 * time, never a whole page body.
 */
import { parseExpiryMarkers, stripTrailingLink } from '../../src/lib/publish/site-expiry.js';
import { parsePageFile } from '../../src/lib/publish/site-import.js';

export interface Item { text: string; raw: string; group: string | null; links: { text: string; href: string }[] }
export interface Block { title: string; directives: Record<string, string>; paragraphs: string[]; items: Item[]; subs: Block[] }

const LINK = /\[([^\]]*)\]\(([^)]*)\)/g;
/** Links, emphasis and highlight marks flattened to their words. */
export function plain(s: string): string {
  return s.replace(LINK, '$1').replace(/==([^=]+)==/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/\s+/g, ' ').trim();
}
const linksOf = (s: string): { text: string; href: string }[] => [...s.matchAll(LINK)].map((m) => ({ text: m[1], href: m[2] }));

/** A page body as `##` blocks, each with `###` sub-blocks: directives, paragraphs, list items (with the `**Group:**` line above them). */
export function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let top: Block | null = null, cur: Block | null = null, group: string | null = null, para: string[] = [], open = true;
  const flush = (): void => {
    if (cur && para.length) cur.paragraphs.push(para.join(' ').trim());
    para = [];
  };
  const mk = (title: string): Block => ({ title, directives: {}, paragraphs: [], items: [], subs: [] });
  for (const line of body.split(/\r?\n/)) {
    const h2 = /^##\s+(.*)$/.exec(line), h3 = /^###\s+(.*)$/.exec(line);
    if (h2) { flush(); top = cur = mk(h2[1].trim()); blocks.push(top); group = null; open = true; continue; }
    if (h3 && top) { flush(); cur = mk(h3[1].trim()); top.subs.push(cur); group = null; open = true; continue; }
    if (!cur) continue;
    const dir = /^@([a-z-]+):\s*(.*)$/.exec(line);
    if (dir && open) { cur.directives[dir[1]] = dir[2].trim(); continue; }
    if (!line.trim()) { flush(); continue; }
    open = false;
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { flush(); cur.items.push({ text: plain(li[1]), raw: li[1], group, links: linksOf(li[1]) }); continue; }
    const g = /^\*\*(.+?)\*\*\s*$/.exec(line.trim());
    if (g) { flush(); group = g[1].replace(/:$/, '').trim(); continue; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

export interface ProfileOrg { legalName: string; state?: string; formed?: string; city?: string; region?: string; remote: boolean }
export interface ProfilePerson { name: string; role: string; titles: string[] }
export interface ProfileService { title: string; tag?: string; honestStatus?: string; specialties: { label: string; text: string; slug: string | null }[]; postSlugs: string[] }
export interface ProfileCredential { label: string; group: string | null; validUntil: string | null; hasMarker: boolean; year?: string; verify?: string }
export interface ProfileEducation { institution: string; years: string; degree: string; label: string }
export interface Profile {
  org: ProfileOrg | null;
  person: ProfilePerson | null;
  mission: { text: string; tenet: string | null } | null;
  principles: { name: string; text: string }[];
  services: ProfileService[];
  dam: { label: string; short: string; text: string } | null;
  credentials: ProfileCredential[];
  education: ProfileEducation[];
  recognition: string[];
  product: { name: string; traits: string[] } | null;
  ring: { label: string; text: string; viewerPath: string | null; leapPath: string | null; leapLabel: string | null; reconstructed: boolean } | null;
  skipped: string[];
}

const postSlug = (href: string): string | null => /^\/blog\/([^/#?]+)\/?(?:[#?].*)?$/.exec(href)?.[1] ?? null;
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function blocksOf(files: Record<string, string>, slug: string): Block[] | null {
  for (const [k, v] of Object.entries(files)) {
    if (!/^content\/[^/]+\.md$/.test(k)) continue;
    const p = parsePageFile(v);
    if (p.status === 'published' && (p.slug || k.replace(/^.*\//, '').replace(/\.md$/, '')) === slug) return parseBlocks(p.body);
  }
  return null;
}

export function extractProfile(files: Record<string, string>): Profile {
  const skipped: string[] = [];
  const about = blocksOf(files, 'about'), services = blocksOf(files, 'services');
  const out: Profile = { org: null, person: null, mission: null, principles: [], services: [], dam: null, credentials: [], education: [], recognition: [], product: null, ring: null, skipped };

  if (about) {
    const intro = about.find((b) => b.directives.section === 'hero')?.paragraphs[0];
    const m = intro ? /^(.+?) is an? ([A-Z][a-z]+) limited liability company/.exec(intro) : null;
    if (intro && m) {
      const loc = /\bin ([A-Z][A-Za-z.]+(?: [A-Z][A-Za-z.]+)*), ([A-Z][a-z]+(?: [A-Z][a-z]+)?)(?:,| working|\.)/.exec(intro);
      out.org = { legalName: m[1], state: m[2], formed: /formed in (\d{4})/.exec(intro)?.[1], city: loc?.[1], region: loc?.[2], remote: /working remotely/.test(intro) };
    } else skipped.push('organization legal form: the About hero does not open with "<name> is a <State> limited liability company"');

    const owner = about.find((b) => b.directives.id === 'owner');
    if (owner) {
      const name = /==([^=]+)==/.exec(owner.title)?.[1];
      const role = /,\s*([a-z][a-z -]+)$/.exec(owner.title)?.[1];
      const t = owner.paragraphs[0] ? /\bof [^:]+: an? ([^.]+?) and an? ([^.]+?)\./.exec(owner.paragraphs[0]) : null;
      if (name && role) out.person = { name, role, titles: t ? [t[1], t[2]] : [] };
      else skipped.push('person: the owner heading is not "==Name==, role"');
      if (!t) skipped.push('person titles: the owner paragraph is not "...: a <title> and an <title>."');
    } else skipped.push('person: the About page has no section with @id: owner');

    const pr = about.find((b) => b.directives.id === 'principles');
    if (pr) {
      const mission = pr.paragraphs.find((p) => !/^==.*==$/.test(p));
      if (mission) out.mission = { text: plain(mission), tenet: pr.paragraphs.map((p) => /^==(.+)==$/.exec(p)?.[1]).find(Boolean) ?? null };
      for (const it of pr.items) {
        const m2 = /^\*\*(.+?)\*\*:?\s*(.*)$/.exec(it.raw);
        if (m2) out.principles.push({ name: m2[1].replace(/:$/, ''), text: capital(plain(it.links.length ? m2[2].replace(/,\s*which\b.*$/, '') : m2[2]).replace(/\.$/, '')) });
        else skipped.push('principle without a bold name: ' + it.text.slice(0, 40));
      }
    } else skipped.push('mission and principles: the About page has no section with @id: principles');

    const bg = about.find((b) => b.directives.id === 'background');
    const sub = (t: string): Block | undefined => bg?.subs.find((s) => s.title.toLowerCase() === t);
    for (const it of sub('credentials')?.items ?? []) {
      const marker = parseExpiryMarkers('- ' + it.raw)[0];
      const label = marker ? marker.text : plain(stripTrailingLink(it.raw.split('|')[0].trim()));
      const verify = it.links.find((l) => /^https:\/\//.test(l.href) && /verify/i.test(l.text))?.href;
      out.credentials.push({ label, group: it.group, validUntil: marker?.validUntil ?? null, hasMarker: !!marker, year: /\((\d{4})\)\s*$/.exec(label)?.[1], verify });
    }
    for (const it of sub('education and research')?.items ?? []) {
      const m3 = /^(.+?), (\d{4}[–-]\d{4}): (.+)$/.exec(it.text);
      if (m3) out.education.push({ institution: m3[1], years: m3[2], degree: m3[3], label: m3[3] + ', ' + m3[1] });
      else skipped.push('education/research entry not in "<institution>, <years>: <degree>" form: ' + it.text.slice(0, 50));
    }
    const rec = sub('recognition')?.paragraphs[0];
    if (rec) out.recognition = plain(rec).replace(/\.$/, '').split(/,? and (?=the |a |an )/).map((x) => x.trim()).filter(Boolean);

    const rk = bg?.subs.flatMap((x) => x.paragraphs).find((x) => /\bbuilding [A-Za-z.]+, the [^:]+: /.test(plain(x)));
    const pm = rk ? /building ([A-Za-z.]+), the [^:]+: (.+?)\./.exec(plain(rk)) : null;
    if (pm) out.product = { name: pm[1], traits: pm[2].split(/,\s*(?:and\s+)?/).map((x) => x.trim()).filter(Boolean) };
    else if (rk) skipped.push('product traits: the Reckons.AI paragraph is not "building <name>, the ...: <traits>."');

    const ring = bg?.subs.find((s) => linksOf(s.paragraphs.join('\n')).some((l) => /[?&]example=/.test(l.href)));
    if (ring) {
      const raw = ring.paragraphs.join('\n');
      const link = linksOf(raw).find((l) => /[?&]example=/.test(l.href));
      let leapPath: string | null = null;
      if (link) { try { const ex = new URL(link.href).searchParams.get('example'); if (ex) leapPath = '/about?example=' + encodeURIComponent(ex); } catch { /* not a URL: no leap */ } }
      const text = plain(ring.paragraphs.find((p) => !p.startsWith('<')) ?? '');
      out.ring = {
        label: plain(ring.title), text, viewerPath: /<iframe[^>]*\ssrc="(\/[^"]+)"/.exec(raw)?.[1] ?? null,
        leapPath, leapLabel: link ? plain(link.text) : null, reconstructed: /\b(reconstructed|rebuilt)\b/i.test(text),
      };
    }
  } else skipped.push('about page: not published or not present');

  if (services) {
    const heroP = services.find((b) => b.directives.section === 'hero')?.paragraphs[0];
    const dm = heroP ? /^(.+?) \(([A-Z]{2,})\) is (.+?)\.(?:\s|$)/.exec(heroP) : null;
    if (dm) out.dam = { label: dm[1], short: dm[2], text: dm[1] + ' (' + dm[2] + ') is ' + dm[3] + '.' };
    const cards = services.find((b) => b.directives.id === 'services');
    if (!cards) skipped.push('services: the Services page has no section with @id: services');
    for (const c of cards?.subs ?? []) {
      const specialties = c.items.map((it) => {
        const first = it.links[0];
        const lead = !!first && new RegExp('^\\s*\\[' + esc(first.text) + '\\]\\(').test(it.raw);
        return { label: lead && first ? first.text : it.text.split(':')[0], text: it.text, slug: lead && first ? postSlug(first.href) : null };
      });
      const slugs = new Set<string>();
      for (const it of c.items) for (const l of it.links) { const s = postSlug(l.href); if (s) slugs.add(s); }
      for (const p of c.paragraphs) for (const l of linksOf(p)) { const s = postSlug(l.href); if (s) slugs.add(s); }
      const hs = c.paragraphs.find((p) => /^Honest status:/i.test(p));
      out.services.push({ title: plain(c.title), tag: c.directives.tag, honestStatus: hs ? plain(hs).replace(/^Honest status:\s*/i, '') : undefined, specialties, postSlugs: [...slugs] });
    }
  } else skipped.push('services page: not published or not present');
  return out;
}
