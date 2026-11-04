#!/usr/bin/env npx tsx
/**
 * Print the test workflows in the Testing graph as JSON (F34.2).
 *
 * WHY A SEPARATE PROCESS. The e2e test has to read its step list from the graph, but Playwright's
 * TypeScript loader cannot load the `n3` parser (it fails inside readable-stream with "Unexpected
 * module status"). So the test runs this under tsx and reads the JSON, which keeps the graph the
 * single source of the steps without teaching the test runner to parse Turtle.
 *
 *   npx tsx scripts/workflow-steps.ts
 */
import { loadWorkflowsFromFile } from './lib/test-workflow.js';

process.stdout.write(JSON.stringify(loadWorkflowsFromFile(), null, 2) + '\n');
