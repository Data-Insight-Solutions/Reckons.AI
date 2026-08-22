import { writeFileSync } from 'node:fs';
import { queueFindings } from '../../pending-queue.js';

const [queue, ready, subject, mode = 'append'] = process.argv.slice(2);
if (!queue || !ready || !subject) process.exit(2);

// The parent test holds the queue lock until both workers have reached this boundary. That makes
// the stale-snapshot race deterministic instead of relying on process scheduling luck.
writeFileSync(ready, 'ready\n');
queueFindings(
  [{ subject, predicate: 'urn:test/predicate', object: subject }],
  {
    agent: mode === 'recompute' ? 'offline:branch-align' : `offline:${subject}`,
    path: queue,
    recomputes: mode === 'recompute',
    kb: 'roadmap',
  },
);
