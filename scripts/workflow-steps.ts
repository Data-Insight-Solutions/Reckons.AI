#!/usr/bin/env npx tsx
/**
 * Print the test workflows in the Testing graph as JSON (F34.2), or one story (F300.3).
 *
 * WHY A SEPARATE PROCESS. The e2e test has to read its step list from the graph, but Playwright's
 * TypeScript loader cannot load the `n3` parser (it fails inside readable-stream with "Unexpected
 * module status"). So the test runs this under tsx and reads the JSON, which keeps the graph the
 * single source of the steps without teaching the test runner to parse Turtle.
 *
 *   npx tsx scripts/workflow-steps.ts                 every workflow, in the docs-page shape
 *   npx tsx scripts/workflow-steps.ts --story=<id>    one story as the unified model (actions, expectations, media)
 */
import { readStoryQuads } from '../src/lib/rdf/story-steps.js';
import { loadWorkflowsFromFile, parseTtl, TESTING_TTL } from './lib/test-workflow.js';

const storyArg = process.argv.find((a) => a.startsWith('--story='))?.slice('--story='.length);
if (storyArg) {
  const story = readStoryQuads(parseTtl(TESTING_TTL), { strict: true }).find((s) => s.id === storyArg);
  if (!story) { console.error(`no story "${storyArg}" in ${TESTING_TTL}`); process.exit(1); }
  process.stdout.write(JSON.stringify(story, null, 2) + '\n');
} else {
  process.stdout.write(JSON.stringify(loadWorkflowsFromFile(), null, 2) + '\n');
}
