/**
 * Vendor the starter graph's photographs — script tier (F74.3), zero tokens.
 *
 * The "This Weekend" starter graph (static/starter-everyday.ttl, F54 kb:soft-onboarding) is a
 * first-time user's first look at Reckons.AI, and it names REAL places. Real places deserve real
 * photographs — but a demo graph must not ship images we do not have the right to ship.
 *
 * So the manifest below is the whole contract:
 *   - every entry carries its licence, creator and the source page a human can open and check;
 *   - only CC0 1.0 and Public Domain Mark are permitted (ALLOWED_LICENCES) — anything else is a
 *     hard failure, not a warning, because a licence we cannot honour is a liability not a photo;
 *   - the same provenance is written into the graph as facts (photo-credit / photo-source), so the
 *     demo graph cites its own sources. That is the thesis, applied to itself: an unverifiable
 *     claim, made by the party it benefits, is not evidence.
 *
 * Images are downscaled to DEST_WIDTH and re-encoded as JPEG. The originals are up to 6048px wide;
 * shipping those into an eagerly-precached build is exactly what kb:pwa-delivery-budget warns about.
 *
 *   npx tsx scripts/offline/fetch-starter-images.ts            # fetch + downscale + write
 *   npx tsx scripts/offline/fetch-starter-images.ts --check    # verify, touch no network
 *   npx tsx scripts/offline/fetch-starter-images.ts --force    # re-fetch files already present
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * The only licences we will ship. CC0 waives rights; PDM marks a work already free of them; `pd`
 * is Wikimedia's plain "Public domain" tag, used here only for US-government works (BLM, Forest
 * Service), which are uncopyrighted at origin. Every one of these permits redistribution with no
 * attribution condition — we attribute anyway, because a source you cannot check is not a source.
 * Deliberately EXCLUDED: CC BY and CC BY-SA. They are usable with attribution, but share-alike in
 * particular is a licensing decision about the repository, not a call a build script should make.
 */
const ALLOWED_LICENCES = new Set(['cc0', 'pdm', 'pd']);

const LICENCE_URL: Record<string, string> = {
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  pdm: 'https://creativecommons.org/publicdomain/mark/1.0/',
  pd: 'https://en.wikipedia.org/wiki/Public_domain'
};

const LICENCE_LABEL: Record<string, string> = {
  cc0: 'CC0 1.0',
  pdm: 'Public Domain Mark 1.0',
  pd: 'Public domain'
};

/** Longest edge in the vendored copy. Big enough for a fullscreen asset view, small enough to ship. */
const DEST_WIDTH = 1200;
const JPEG_QUALITY = 78;
const DEST_DIR = 'static/png/starter';

export interface StarterImage {
  /** File basename, and the slug used in the rooted path the graph references. */
  slug: string;
  /** The starter-graph entity this illustrates — kept here so the manifest is self-documenting. */
  entity: string;
  /** Direct image URL. */
  url: string;
  /** Licence identifier; must be in ALLOWED_LICENCES. */
  licence: string;
  /** Attributed creator, as reported by the source. CC0 does not require attribution — we do it anyway. */
  creator: string;
  /** The page a human can open to check the licence claim for themselves. */
  sourcePage: string;
  /** Title as published at the source. */
  title: string;
}

/**
 * Licences and creators here are as reported by the Openverse API at the time of vendoring
 * (2026-07-23). `--check` re-verifies the files; it does NOT re-verify the upstream licence,
 * because upstream can change after the fact and our copy is governed by the licence at the
 * time it was granted. The source page is recorded so the claim stays checkable.
 */
export const MANIFEST: StarterImage[] = [
  /**
   * NOT the obvious candidate. Wikimedia's "Lake George, Mammoth Lakes (52972865396)" is CC0 and
   * well-sized, but its own Credit field reads "13 Lake Mamie, Mammoth Lakes (3)" — the title and
   * the source disagree about which lake is in the frame, and we cannot settle it. Labelling a
   * possible Lake Mamie as Lake George in a demo graph about verifiable facts would be the exact
   * failure the product exists to catch, so it is rejected in favour of a photo whose own title
   * identifies Lake George in the shot.
   */
  {
    slug: 'lake-george',
    entity: 'kb:lake-george',
    url: 'https://live.staticflickr.com/65535/54642164587_d726bebac4_b.jpg',
    licence: 'cc0',
    creator: 'The Fun Chronicles',
    sourcePage: 'https://www.flickr.com/photos/196406308@N04/54642164587',
    title: 'Deer Lakes trail views — Lake George (near), Lake Mary (far), Mammoth Lakes'
  },
  {
    slug: 'oh-ridge',
    entity: 'kb:oh-ridge',
    url: 'https://live.staticflickr.com/65535/52972474892_83dae31b65_b.jpg',
    licence: 'cc0',
    creator: 'The Fun Chronicles',
    sourcePage: 'https://www.flickr.com/photos/196406308@N04/52972474892',
    title: 'June Lake, California'
  },
  {
    slug: 'eastern-sierra',
    entity: 'kb:eastern-sierra',
    url: 'https://upload.wikimedia.org/wikipedia/commons/c/c0/Eastern_Sierra_Nevada_Foothills_Near_Big_Pine_California_04_30_2022_2.jpg',
    licence: 'cc0',
    creator: 'Z3lvs',
    sourcePage: 'https://commons.wikimedia.org/w/index.php?curid=142713117',
    title: 'Eastern Sierra Nevada foothills near Big Pine, California'
  },
  {
    slug: 'san-francisco',
    entity: 'kb:san-francisco',
    url: 'https://upload.wikimedia.org/wikipedia/commons/b/bc/San_Francisco_skyline_from_Marin_Headlands.jpg',
    licence: 'cc0',
    creator: 'Ryan Schwark',
    sourcePage: 'https://commons.wikimedia.org/w/index.php?curid=161349162',
    title: 'San Francisco skyline from the Marin Headlands'
  },
  {
    slug: 'los-angeles',
    entity: 'kb:los-angeles',
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/a0/Los_Angeles_Skyline%3B_August_30%2C_2022.jpg',
    licence: 'cc0',
    creator: 'ItzAPotato2009',
    sourcePage: 'https://commons.wikimedia.org/w/index.php?curid=157019541',
    title: 'Los Angeles skyline'
  },
  {
    slug: 'drive-395',
    entity: 'kb:ev-alex-drive',
    url: 'https://live.staticflickr.com/65535/52977261205_7eeddb8307_b.jpg',
    licence: 'cc0',
    creator: 'The Fun Chronicles',
    sourcePage: 'https://www.flickr.com/photos/196406308@N04/52977261205',
    title: 'Land to the west of US Highway 395, California'
  },
  {
    slug: 'sunrise-shoot',
    entity: 'kb:ev-sunrise-shoot',
    url: 'https://live.staticflickr.com/4556/24809580078_d6133aaef7_b.jpg',
    licence: 'pdm',
    // The image carries a visible "Andrew D Cox" signature; the hosting stream is the Forest
    // Service's. Both are recorded rather than picking one and hoping.
    creator: 'Andrew D Cox / U.S. Forest Service',
    sourcePage: 'https://www.flickr.com/photos/140082569@N07/24809580078',
    title: 'Sunrise from the high country, Inyo National Forest'
  },
  {
    slug: 'campfire',
    entity: 'kb:ev-campfire',
    url: 'https://live.staticflickr.com/4875/45365195765_5aa088ba86_b.jpg',
    licence: 'pdm',
    creator: 'U.S. Forest Service, Pacific Northwest Region',
    sourcePage: 'https://www.flickr.com/photos/135886671@N08/45365195765',
    title: 'Campfire in a rock ring, Malheur National Forest'
  },
  /**
   * Found only by searching Wikimedia Commons DIRECTLY (Matt's suggestion) rather than through
   * Openverse — Commons indexes by place, so a Mono County campsite surfaces where a keyword
   * search for "campsite" returned Arizona signboards and a lit tent under Joshua trees in the
   * Mojave. Those were rejected: a desert photo on an Eastern Sierra node illustrates a place the
   * graph is not describing, which is a false claim whatever the caption says. This one is an
   * actual Eastern Sierra campsite — fire ring, picnic table, snow still on the peak behind it.
   */
  {
    slug: 'pitch-camp',
    entity: 'kb:ev-pitch-camp',
    url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/16/Crowley_Lake_campground_site_%2848061851118%29.jpg/1280px-Crowley_Lake_campground_site_%2848061851118%29.jpg',
    licence: 'pd',
    creator: 'Bureau of Land Management California',
    sourcePage: 'https://commons.wikimedia.org/wiki/File:Crowley_Lake_campground_site_(48061851118).jpg',
    title: 'Campsite at Crowley Lake, Mono County — Eastern Sierra'
  }
];

/** The rooted path the graph references. Static assets are served from the site ROOT, never /static. */
export function publicPath(img: StarterImage): string {
  return `/png/starter/${img.slug}.jpg`;
}

/** One-line credit, written into the graph beside the photo. */
export function creditLine(img: StarterImage): string {
  return `${img.creator} · ${LICENCE_LABEL[img.licence]}`;
}

export function licenceUrl(img: StarterImage): string {
  return LICENCE_URL[img.licence];
}

/** Fail loudly on a licence we have not cleared. A demo image is never worth a licence risk. */
export function assertLicencesAllowed(manifest: StarterImage[] = MANIFEST): void {
  const bad = manifest.filter((m) => !ALLOWED_LICENCES.has(m.licence));
  if (bad.length) {
    throw new Error(
      `Refusing to vendor ${bad.length} image(s) under a licence that is not CC0 or Public Domain Mark:\n` +
        bad.map((b) => `  ${b.slug}: ${b.licence} (${b.sourcePage})`).join('\n')
    );
  }
  const slugs = manifest.map((m) => m.slug);
  const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (dupes.length) throw new Error(`Duplicate slug(s) in the manifest: ${[...new Set(dupes)].join(', ')}`);
}

/**
 * Wikimedia rate-limits (429) a burst of full-size originals from one host, so back off and retry
 * rather than failing the run — a partial vendoring leaves the graph pointing at files that do not
 * exist. Retries only on 429/5xx; a 404 is a manifest bug and should fail immediately.
 */
async function fetchWithBackoff(img: StarterImage, attempts = 4): Promise<Response> {
  let delay = 2000;
  for (let i = 1; ; i++) {
    const res = await fetch(img.url, {
      headers: { 'User-Agent': 'Reckons.AI starter-image vendoring (github.com/reckons-ai)' }
    });
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || i >= attempts) {
      throw new Error(`${img.slug}: HTTP ${res.status} fetching ${img.url}`);
    }
    console.log(`  … ${img.slug}: HTTP ${res.status}, retrying in ${delay / 1000}s (${i}/${attempts - 1})`);
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
}

async function fetchAndWrite(img: StarterImage, dest: string): Promise<number> {
  const res = await fetchWithBackoff(img);

  const original = Buffer.from(await res.arrayBuffer());
  const out = await sharp(original)
    .rotate() // honour EXIF orientation before we discard the metadata
    .resize({ width: DEST_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  writeFileSync(dest, out);
  return out.length;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const force = args.includes('--force');

  assertLicencesAllowed();

  if (check) {
    const missing = MANIFEST.filter((m) => !existsSync(join(DEST_DIR, `${m.slug}.jpg`)));
    if (missing.length) {
      console.error(`✗ ${missing.length} vendored image(s) missing: ${missing.map((m) => m.slug).join(', ')}`);
      console.error('  Run: npx tsx scripts/offline/fetch-starter-images.ts');
      process.exit(1);
    }
    const total = MANIFEST.reduce((n, m) => n + statSync(join(DEST_DIR, `${m.slug}.jpg`)).size, 0);
    console.log(`✓ ${MANIFEST.length} starter images present, all CC0/PDM (${(total / 1024).toFixed(0)} KB total)`);
    return;
  }

  mkdirSync(DEST_DIR, { recursive: true });

  let fetched = 0;
  let skipped = 0;
  let bytes = 0;

  for (const img of MANIFEST) {
    const dest = join(DEST_DIR, `${img.slug}.jpg`);
    if (existsSync(dest) && !force) {
      bytes += statSync(dest).size;
      skipped++;
      console.log(`  = ${img.slug} (present, --force to re-fetch)`);
      continue;
    }
    const size = await fetchAndWrite(img, dest);
    bytes += size;
    fetched++;
    console.log(`  ✓ ${img.slug}  ${(size / 1024).toFixed(0)} KB  ${LICENCE_LABEL[img.licence]}  ${img.creator}`);
  }

  console.log(`\n${fetched} fetched, ${skipped} already present — ${(bytes / 1024).toFixed(0)} KB in ${DEST_DIR}`);
  console.log('Provenance (credit + source page) lives in static/starter-everyday.ttl beside each photo.');
}

// Only run when invoked directly, so the manifest can be imported by tests.
if (process.argv[1]?.endsWith('fetch-starter-images.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
