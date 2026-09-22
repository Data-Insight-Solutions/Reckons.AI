<script lang="ts">
  import type { ExtractionRun, ExtractionStageName, Source, Statement } from '$lib/rdf/types';

  let { source, runs, statements, loading = false, error = '' } = $props<{
    source?: Source;
    runs: ExtractionRun[];
    statements: Statement[];
    loading?: boolean;
    error?: string;
  }>();
  const stageLabels: Record<ExtractionStageName, string> = {
    route: 'Choose model', extract: 'Extract statements', validate: 'Validate statements',
    ground: 'Check excerpts', normalize: 'Match entities', type: 'Assign types',
    group: 'Find sets', archive: 'Retain source', diff: 'Compare with graph', persist: 'Save results',
  };
  const date = (time: number) => new Date(time).toLocaleString();
  function linkedCount(run: ExtractionRun): number {
    const outputIds = new Set(run.outputStatementIds);
    return statements.filter((st: Statement) => st.extractionRunId === run.id || outputIds.has(st.id)).length;
  }
</script>

<section class="extraction-trail" aria-label="Extraction history">
  <h4>How extraction happened</h4>
  {#if loading}
    <p role="status">Loading execution records…</p>
  {:else if error}
    <p role="alert">{error}</p>
  {:else if runs.length === 0}
    <p>No extraction execution record is available for this source.</p>
    {#if source?.extractionModel || source?.extractionBackend}
      <p>Recorded on source: {source.extractionModel || 'model not recorded'}
        {#if source.extractionBackend} · {source.extractionBackend}{/if}.
        The individual steps were not retained here.</p>
    {:else if source?.kind === 'turtle'}
      <p>This source was imported as a graph. Its earlier extraction process is not recorded here.</p>
    {/if}
  {:else}
    {#each [...runs].reverse() as run (run.id)}
      <details class="run" open={runs.length === 1}>
        <summary>{date(run.startedAt)} · {run.status}</summary>
        <p class="model">{run.route.selectedModel || 'Model not recorded'} · {run.route.selectedBackend}
          <span class="locality">{run.route.locality}</span></p>
        <ol class="stages" aria-label="Recorded extraction steps">
          {#each run.stages as stage (stage.name)}
            <li class:failed={stage.status === 'failed'} class:succeeded={stage.status === 'succeeded'}>
              <span class="stage-mark" aria-hidden="true">{stage.status === 'succeeded' ? '✓' : stage.status === 'failed' ? '!' : stage.status === 'skipped' ? '–' : '○'}</span>
              <div><strong>{stageLabels[stage.name as ExtractionStageName] ?? stage.name}</strong>
                <span class="stage-status">{stage.status === 'pending' && run.status !== 'running' ? 'not reached' : stage.status}</span>
                {#if stage.detail}<p>{stage.detail}</p>{/if}
                {#if stage.startedAt != null && stage.endedAt != null}
                  <small>{Math.max(0, stage.endedAt - stage.startedAt)} ms</small>
                {/if}
              </div>
            </li>
          {/each}
        </ol>
        {#if run.candidateStatementCount != null}<p>{run.candidateStatementCount} candidate statements recorded.</p>{/if}
        <p>{run.outputStatementIds.length} recorded outputs · {linkedCount(run)} retained statements linked to this run.</p>
        {#if run.validationCounts}
          <p>{run.validationCounts.grounded} excerpts matched the source · {run.validationCounts.ungrounded} did not.</p>
        {/if}
        {#if run.failure}<p class="failure">{run.failure.message}</p>{/if}
        {#if run.route.attempts.length > 0}
          <details><summary>Model attempts ({run.route.attempts.length})</summary>
            <ul>{#each run.route.attempts as attempt (attempt.id)}
              <li>{attempt.model || 'Model not recorded'} · {attempt.backend} · {attempt.locality} · {attempt.status}
                {#if attempt.error}<p>{attempt.error}</p>{/if}</li>
            {/each}</ul>
          </details>
        {/if}
      </details>
    {/each}
  {/if}
</section>

<style>
  h4 { margin: 0 0 0.6rem; font-size: 0.95rem; }
  p, li { font-size: 0.82rem; line-height: 1.5; overflow-wrap: anywhere; }
  p { margin: 0.5rem 0; }
  summary { cursor: pointer; font-size: 0.83rem; padding: 0.5rem 0; }
  .run { border-top: 1px solid var(--line); }
  .model { color: var(--ink); }
  .locality { display: block; color: var(--muted); }
  .stages { list-style: none; padding: 0; margin: 0.75rem 0; }
  .stages li { position: relative; display: flex; gap: 0.6rem; padding: 0 0 0.8rem; }
  .stages li:not(:last-child)::before { content: ''; position: absolute; left: 10px; top: 22px; bottom: 0; border-left: 1px solid var(--line); }
  .stage-mark { flex: 0 0 22px; height: 22px; border: 1px solid var(--line); border-radius: 50%; text-align: center; }
  .stage-status { margin-left: 0.5rem; color: var(--muted); }
  .stages p { margin: 0.15rem 0; color: var(--muted); }
  small { color: var(--muted); }
  .succeeded .stage-mark { color: var(--accent); border-color: var(--accent); }
  .failed .stage-mark, .failure { color: var(--danger, #f87171); }
</style>
