/**
 * Website alignment (F111) — what the site was DESIGNED to be, versus what it actually IS.
 *
 * This is the roadmap↔production pattern one level down. `reckons-roadmap.ttl` states intent,
 * `reckons-production.ttl` states deployed reality, and F26 scores the gap; here
 * `static/website.ttl` states the intended docs site and an OBSERVED status graph states what the
 * output actually contains. Drift between them is then a number rather than an impression.
 *
 * WHY THAT MATTERS RIGHT NOW: "the docs are a mess" is true and unactionable. 269 pages the
 * design never asked for, and 8 pages the design asks for that do not exist, is the same
 * statement in a form you can work down to zero.
 *
 * ── THE OBSERVED SIDE MUST BE OBSERVED ──────────────────────────────────────────────────────
 * The status graph is DERIVED FROM THE OUTPUT, never written alongside it. A status graph
 * generated from the same source that produced the pages would agree with itself by construction
 * and prove nothing — the renderer certifying its own render. Today the observation is at the
 * CONTENT layer (the files the site is built from, read back through the same frontmatter parser
 * the site uses). That is one step short of observing the rendered DOM, and this module says so
 * rather than implying full F111 phase-2 coverage: it can tell you a page exists and what it
 * claims to be, not what a browser actually painted.
 *
 * ── FOUR DIVERGENCES, AND WHY EACH IS SEPARATE ──────────────────────────────────────────────
 * They are not interchangeable and must never be summed into one "mismatch" count:
 *
 *   UNDECLARED  in the output, absent from the design. Not an error — it is content someone
 *               made. It is the sign the design does not yet describe the site. Today: ~269.
 *   UNBUILT     in the design, absent from the output. The design is aspirational here, and
 *               `kb:honest-status` says a plan written in the present tense is a lie with good
 *               manners. Today: all 8.
 *   DIVERGENT   present in both, disagreeing about a field. The only kind that is unambiguously
 *               a bug, because two answers exist and one is wrong.
 *   ALIGNED     present in both and agreeing.
 *
 * Pure: two lists in, a report out. No filesystem, no parser.
 */

/** A page as the DESIGN declares it. */
export interface IntendedPage {
  id: string;
  title: string;
  slug: string;
  section: string;
  /** Menu group this page is offered under, if any. A page can exist and not be offered. */
  menu?: string;
  template?: string;
  position?: number;
  /** Resolvable live URL, so a divergence report links straight to the page in question. */
  url?: string;
}

/** A page as the OUTPUT actually contains it. */
export interface ObservedPage {
  /** Repo-relative file, e.g. "content/guide/getting-started.md". */
  path: string;
  slug: string;
  section: string;
  title: string;
  template: string;
  status: string;
  nav: string;
  /** Provenance tag written by the docs generator (`"docs-kb"`), absent on hand-authored pages. */
  generated?: string;
  /** Where this page is actually served — derived from its path, not asserted beside it. */
  url: string;
}

export interface FieldDivergence {
  slug: string;
  field: 'title' | 'section' | 'template';
  intended: string;
  observed: string;
}

export interface WebsiteAlignment {
  intendedCount: number;
  observedCount: number;
  aligned: string[];
  /** In the output, not in the design. Content that exists for no stated reason. */
  undeclared: ObservedPage[];
  /** In the design, not in the output. Intent that has not been built. */
  unbuilt: IntendedPage[];
  divergent: FieldDivergence[];
  /** How many undeclared pages were machine-generated — the difference between mess and drift. */
  undeclaredGenerated: number;
  score: number;
  /** Exactly what `score` measured, so the number is never quoted without its definition. */
  scoreBasis: string;
}

/** Identity of a page across both sides: section + slug, which is also its file path. */
function key(section: string, slug: string): string {
  return `${section.trim().toLowerCase()}/${slug.trim().toLowerCase()}`;
}

/**
 * Compare intended pages against observed ones.
 *
 * The score is deliberately SIMPLE and its formula travels with it in `scoreBasis`. A composite
 * with hidden weights invites arguing about the weights instead of fixing the site, and a number
 * quoted without its definition is the kind of unverifiable claim this project exists to refuse.
 *
 * score = aligned / (aligned + unbuilt + undeclared + divergent)
 *
 * Undeclared pages count AGAINST alignment on purpose. A site that publishes 269 pages nobody
 * designed is not aligned with an 8-page design just because those 8 happen to exist too.
 */
export function alignWebsite(
  intended: IntendedPage[],
  observed: ObservedPage[],
): WebsiteAlignment {
  const observedByKey = new Map(observed.map((p) => [key(p.section, p.slug), p]));
  const intendedByKey = new Map(intended.map((p) => [key(p.section, p.slug), p]));

  const aligned: string[] = [];
  const unbuilt: IntendedPage[] = [];
  const divergent: FieldDivergence[] = [];

  for (const want of intended) {
    const got = observedByKey.get(key(want.section, want.slug));
    if (!got) {
      unbuilt.push(want);
      continue;
    }
    aligned.push(want.slug);

    // Compared case-insensitively: a title differing only in case is a style question, not a
    // divergence worth spending a reviewer's attention on.
    if (want.title && got.title && want.title.toLowerCase() !== got.title.toLowerCase()) {
      divergent.push({ slug: want.slug, field: 'title', intended: want.title, observed: got.title });
    }
    if (want.template && got.template && want.template !== got.template) {
      divergent.push({
        slug: want.slug, field: 'template', intended: want.template, observed: got.template,
      });
    }
  }

  const undeclared = observed
    .filter((p) => !intendedByKey.has(key(p.section, p.slug)))
    .sort((a, b) => a.path.localeCompare(b.path));

  const denominator = aligned.length + unbuilt.length + undeclared.length + divergent.length;
  const score = denominator === 0 ? 1 : aligned.length / denominator;

  return {
    intendedCount: intended.length,
    observedCount: observed.length,
    aligned: aligned.sort(),
    undeclared,
    unbuilt,
    divergent,
    undeclaredGenerated: undeclared.filter((p) => p.generated).length,
    score,
    scoreBasis:
      'aligned / (aligned + unbuilt + undeclared + divergent) — undeclared pages count against '
      + 'alignment, because a site publishing pages nobody designed is not aligned with the design.',
  };
}

/**
 * One honest paragraph. Each divergence kind is named separately because they need different
 * actions: undeclared pages want a design decision, unbuilt pages want building, and divergent
 * pages want a fix.
 */
export function describeAlignment(a: WebsiteAlignment): string {
  const pct = `${Math.round(a.score * 100)}%`;
  const parts = [`${pct} aligned — ${a.aligned.length} of ${a.intendedCount} designed pages exist.`];

  if (a.undeclared.length > 0) {
    const gen = a.undeclaredGenerated;
    const hand = a.undeclared.length - gen;
    const detail = gen > 0 && hand > 0
      ? ` (${gen} machine-generated, ${hand} hand-authored)`
      : gen > 0 ? ' (all machine-generated)' : ' (all hand-authored)';
    parts.push(`${a.undeclared.length} published page(s) the design does not describe${detail}.`);
  }
  if (a.unbuilt.length > 0) {
    parts.push(`${a.unbuilt.length} designed page(s) do not exist yet: ${a.unbuilt.map((p) => p.slug).join(', ')}.`);
  }
  if (a.divergent.length > 0) {
    parts.push(`${a.divergent.length} field(s) disagree between design and output.`);
  }
  if (a.undeclared.length === 0 && a.unbuilt.length === 0 && a.divergent.length === 0) {
    parts.push('The site is exactly what the design describes.');
  }
  return parts.join(' ');
}
