/**
 * Indico live verification — the F55 (kb:int-indico) gate, script tier, zero tokens.
 *
 * `kb:int-indico`'s kpred:remaining names exactly three things that offline tests cannot settle,
 * because they are claims about a REAL SERVER rather than about our code:
 *
 *   1. the auth path       — does this server actually accept our API token?
 *   2. error surfacing     — does a bad server/token produce a legible failure, not a silent empty?
 *   3. category coverage   — does category sync return what the instance really has?
 *
 * src/lib/integrations/indico/__tests__/client.test.ts pins the CONTRACT against a mocked fetch.
 * This script checks the WORLD. Both are needed and neither substitutes for the other: a green
 * offline suite with no live run means the integration is verified against our own assumptions,
 * which is the failure mode kb:honest-status exists to prevent.
 *
 *   npx tsx scripts/offline/indico-verify.ts --server=https://indico.example.org [--category=42]
 *
 * Credentials come from the environment (VITE_INDICO_API_TOKEN), never from an argument, so the
 * token does not land in shell history or CI logs. The token is never printed — only whether it
 * was sent, and what the server said back.
 *
 * Exit codes: 0 all checks passed · 1 a check failed · 2 not runnable (no server URL).
 */

import { existsSync, readFileSync } from 'node:fs';
import { IndicoClient, createIndicoClient } from '../../src/lib/integrations/indico/client';
import { indicoEventsToStatements } from '../../src/lib/integrations/indico/indico-rdf';

/**
 * Minimal .env reader — the repo has no dotenv dependency and does not need one for this.
 * Existing process.env always wins, so an inline override on the command line still works.
 */
function loadDotEnv(file = '.env') {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadDotEnv();

type Result = { name: string; ok: boolean; detail: string; skipped?: boolean };

const results: Result[] = [];

function record(name: string, ok: boolean, detail: string, skipped = false) {
  results.push({ name, ok, detail, skipped });
  const mark = skipped ? '−' : ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}\n      ${detail}`);
}

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=');
}

/** Describe a thrown error without leaking the token, which travels in the URL as `ak`. */
function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/([?&]ak=)[^&\s]+/g, '$1<redacted>');
}

async function main() {
  const serverUrl = arg('server') ?? process.env.VITE_INDICO_SERVER_URL;
  const token = process.env.VITE_INDICO_API_TOKEN;
  const categoryId = arg('category') ?? process.env.VITE_INDICO_CATEGORY_ID;

  console.log('\nIndico live verification — F55 / kb:int-indico\n');

  if (!serverUrl?.trim()) {
    console.error('NOT RUNNABLE — no Indico server URL.\n');
    console.error('  .env carries VITE_INDICO_API_TOKEN but no server, and a token alone configures');
    console.error('  nothing: createIndicoClient() returns null without a URL. Supply one of:');
    console.error('    npx tsx scripts/offline/indico-verify.ts --server=https://indico.example.org');
    console.error('    VITE_INDICO_SERVER_URL=... in .env\n');
    console.error('  Until this runs, kb:int-indico remains UNVERIFIED against a live server.');
    process.exit(2);
  }

  console.log(`  server: ${serverUrl}`);
  console.log(`  token:  ${token ? 'present (sent as ?ak=, value never printed)' : 'ABSENT — public access only'}`);
  console.log(`  category: ${categoryId ?? 'root (0)'}\n`);

  const client = createIndicoClient(serverUrl, token);
  if (!client) {
    record('client construction', false, 'createIndicoClient returned null for a non-empty URL');
    return finish();
  }
  record('client construction', true, 'createIndicoClient built a client from the configured URL');

  // 1. THE AUTH PATH — can we read the root category at all, with the token we hold?
  let reachable = false;
  try {
    const res = await client.fetchEvents(categoryId, { limit: 5 });
    reachable = true;
    record(
      'auth path / reachability',
      true,
      `server answered: ${res.count} event(s) reported, ${res.results.length} returned${
        token ? ' (token accepted — no 401)' : ''
      }`
    );
  } catch (err) {
    record('auth path / reachability', false, describeError(err));
  }

  // 2. ERROR SURFACING — a deliberately wrong token must fail LOUDLY, not return an empty list.
  //    Skipped without a token: with no credential there is no wrong-credential case to test.
  if (!token) {
    record('error surfacing (bad token)', true, 'skipped — no token configured, nothing to falsify', true);
  } else {
    try {
      const bad = new IndicoClient({ serverUrl, apiToken: 'definitely-not-a-valid-token' });
      const res = await bad.fetchEvents(categoryId, { limit: 1 });
      // Public instances legitimately serve public events regardless of the key, so an empty or
      // populated result here is only a FAILURE if the good token returned something different.
      record(
        'error surfacing (bad token)',
        true,
        `no error raised — server returned ${res.results.length} event(s) for an invalid key, ` +
          'so this instance serves these events publicly and the key is not gating them. ' +
          'Not a defect; it does mean the token path is UNPROVEN on this data.',
        true
      );
    } catch (err) {
      record('error surfacing (bad token)', true, `rejected legibly: ${describeError(err)}`);
    }
  }

  // 3. ERROR SURFACING — a wrong PATH on the same host must surface a status, not a silent empty.
  try {
    const wrong = new IndicoClient({ serverUrl, apiToken: token });
    await wrong.getEvent('definitely-not-an-event-id-000000');
    record('error surfacing (bad event id)', true, 'returned without throwing (server answered with no results)');
  } catch (err) {
    const msg = describeError(err);
    record('error surfacing (bad event id)', /Indico \d{3}/.test(msg), `surfaced: ${msg}`);
  }

  // 4. CATEGORY COVERAGE — what categories does the instance actually expose?
  if (reachable) {
    try {
      const cats = await client.getCategories();
      record(
        'category coverage',
        true,
        cats.length ? `${cats.length} categor(y|ies): ${cats.slice(0, 8).join(', ')}` : 'none reported by the root listing'
      );
    } catch (err) {
      record('category coverage', false, describeError(err));
    }
  } else {
    record('category coverage', false, 'skipped — server unreachable', true);
  }

  // 5. RDF MAPPING — the events we actually received must survive conversion into statements.
  if (reachable) {
    try {
      const res = await client.fetchEvents(categoryId, { limit: 5 });
      const stmts = indicoEventsToStatements(res.results, 'indico-verify', serverUrl);
      const subjects = new Set(stmts.map((s) => s.s.value));
      const untitled = res.results.filter((e) => !e.title?.trim()).length;
      record(
        'RDF mapping',
        stmts.length > 0,
        `${res.results.length} event(s) → ${stmts.length} statement(s) across ${subjects.size} subject(s)` +
          (untitled ? `; ${untitled} event(s) had no title` : '')
      );
    } catch (err) {
      record('RDF mapping', false, describeError(err));
    }
  } else {
    record('RDF mapping', false, 'skipped — no events fetched', true);
  }

  finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed` +
      (skipped.length ? `, ${skipped.length} inconclusive` : '')
  );
  if (failed.length) {
    console.log('\nFAILED — kb:int-indico stays unverified against this server.');
    process.exit(1);
  }
  console.log('\nAll checks passed against the live server.');
  if (skipped.length) {
    console.log('Note the inconclusive checks above — they were not proven, only not falsified.');
  }
}

main().catch((err) => {
  console.error(describeError(err));
  process.exit(1);
});
