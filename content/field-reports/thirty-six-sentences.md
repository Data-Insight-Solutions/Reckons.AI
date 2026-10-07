---
title: "Thirty-six sentences"
slug: "thirty-six-sentences"
order: 10
section: "Field reports"
template: post
status: published
nav: sidebar
date: "2026-10-06"
excerpt: "One session on a $20-a-month plan: 36 short messages over 5.7 hours became 15 pull requests, with scripts and two local GPUs doing most of the work."
---

<p class="fr-eyebrow">Field report · one evening · Reckons.AI</p>

# Thirty-six sentences, two GPUs, one $20 plan

<p class="fr-lede">All of this ran in a single session on a $20-a-month Claude plan, used to its limit, with no API key and no metered billing. Over 5.7 hours I sent 36 short messages to a coding agent while I got on with other things. In that time 15 pull requests were opened and 19 merged, each after green CI. Scripts and open models on my own GPUs did most of the work, and the cloud model saved its attention for the decisions.</p>

<p class="fr-meta"><span>1 session · $20/month plan</span><span>2 × RTX 3090 (48 GB)</span><span>18 local models via Ollama</span><span>Claude Code as orchestrator</span></p>

## What I typed

<div class="fr-figures">
  <div><b>36</b><span>messages from me, plus three pasted screens of the agent monitor</span></div>
  <div><b>16</b><span>words in the median message; the longest was 74</span></div>
  <div><b>5.7 h</b><span>first message to last, mostly in short bursts with gaps up to 90 minutes</span></div>
  <div><b>15 / 19</b><span>pull requests opened / merged into dev, each through CI</span></div>
</div>

Most messages were a direction, a correction or a yes. The agent planned each change in the project's roadmap graph first, built it in its own branch, ran the checks, and queued it to merge. A few, word for word:

<ul class="fr-quotes">
  <li>"Remember to use local agent jobs, another big improvement for this release."</li>
  <li>"We should compare with front end renders, which is more impactful for time."</li>
  <li>"agreed localhost should serve dev"</li>
  <li>"pplease rerun for me and go higher"</li>
  <li>"I love the emoji turtle walking in the new agent watch."</li>
</ul>

<p class="fr-note">Counted from the session transcript. Tool results, system notices and the pasted monitor screens are excluded, and answers to multiple-choice prompts count as clicks, not messages.</p>

## What the machine did

<div class="fr-figures">
  <div><b>−42%</b><span>weighted cloud tokens per message, against the median of six earlier long sessions</span></div>
  <div><b>527</b><span>inference calls to local models, at no subscription cost</span></div>
  <div><b>218</b><span>proposals local jobs queued for human review, none written to the graph directly</span></div>
  <div><b>42</b><span>deterministic checks run on every branch, at zero tokens</span></div>
</div>

## Cloud tokens per message

Each long session on this repository, measured by the project's own token script from Claude Code's transcripts. "Weighted" uses rough price ratios: input + 1.25 × cache write + 0.1 × cache read + 5 × output.

<div class="fr-chart" role="img" aria-label="Weighted tokens per message, in thousands: Sep 8 56.3, Sep 10 55.3, Sep 17 62.0, Sep 21 58.2, Sep 29 71.5, Sep 30 60.1, this session 34.6">
  <div class="fr-row"><span>Sep 8</span><i><em style="width:70.4%"></em></i><span>56.3K</span></div>
  <div class="fr-row"><span>Sep 10</span><i><em style="width:69.1%"></em></i><span>55.3K</span></div>
  <div class="fr-row"><span>Sep 17</span><i><em style="width:77.5%"></em></i><span>62.0K</span></div>
  <div class="fr-row"><span>Sep 21</span><i><em style="width:72.8%"></em></i><span>58.2K</span></div>
  <div class="fr-row"><span>Sep 29</span><i><em style="width:89.4%"></em></i><span>71.5K</span></div>
  <div class="fr-row"><span>Sep 30</span><i><em style="width:75.1%"></em></i><span>60.1K</span></div>
  <div class="fr-row fr-now"><span>Oct 6</span><i><em style="width:43.3%"></em></i><span>34.6K</span></div>
  <div class="fr-axis"><span></span><i><span>0</span><span>20K</span><span>40K</span><span>60K</span><span>80K</span></i><span></span></div>
</div>

<div class="fr-caution">
  <strong>How far to trust this number</strong>
  <p>Per-message cost is a crude measure. The sessions did different work, this one was compacted once, and the weights approximate price rather than reproduce a bill. Treat −42% as a direction, not a benchmark.</p>
</div>

## How the work was split

Each recurring task goes to the cheapest worker that can do it correctly. A script whose answer a rule can check beats a model; a local model beats a cloud one when its output is only a proposal a person reviews.

<div class="fr-tiers">
  <div><span class="fr-tag">script</span><p>42 offline checks (graph lint, terminology and naming ratchets, the jobs graph, codebase coverage), the merge queue, and size benchmarks from 10k to 250k statements.</p></div>
  <div><span class="fr-tag">local model</span><p>First-pass code review, a mixed-model terminology panel, docs drafting, decision distillation, competitor and alignment sweeps.</p></div>
  <div><span class="fr-tag fr-tag-cloud">cloud</span><p>Design and planning, triaging what the local jobs found, and writing the code that merged.</p></div>
</div>

## What the local work found

- **Rendering, not the file format, limits big spaces.** At 10k statements the browser import took 4 s and the first 3D frame 12 s; at 100k the import took about 150 s. Node loads 250k statements in 10 to 11 s.
- **A local review paid for itself once in four.** Three findings misread the code; the fourth caught a real bug, a wait that could never end. It was fixed and tested.
- **Counting words needs syntax awareness.** 1,771 of 2,142 counted uses of "export" were the JavaScript keyword. A positional rule fixed the count before it became a baseline.
- **Coverage was lower than the notes claimed.** 61% of code files were linked from the codebase graph, not 100%. A ratchet now stops it falling.

## What it cost

- **Heat.** A batch started outside the scheduler drove one GPU to 89 °C. Batch runs now check the same heat and memory limits as the scheduler before every job.
- **Review debt.** Local jobs have produced 2,651 proposals; 1,791 were never looked at. Offloading moves cost from generating to reviewing.
- **Contention.** Some local reviews timed out while other jobs held the GPUs.
- **Small context, wrong slice.** The graph-compression tool answered a "what changed recently" question with 0.2% of the graph, but picked a month-old entry, because its search has no sense of recency.

## The fixes

<div class="fr-tiers">
  <div><span class="fr-tag">planned</span><p>Stream local model responses and time out on silence, not total length.</p></div>
  <div><span class="fr-tag">planned</span><p>Back-pressure: hold a job while its own unreviewed proposals are over a limit.</p></div>
  <div><span class="fr-tag">this week</span><p>Clean up stale and duplicate proposals by script; sample each job nobody reviews and keep, demote or retire it.</p></div>
  <div><span class="fr-tag">this week</span><p>Recency from git history, so search can weight what is new, and a context benchmark scored by local models.</p></div>
</div>

<p class="fr-note">Measured 2026-10-06 and 2026-10-07 with the project's own scripts and the Ollama server log. The code is open source: <a href="https://github.com/Data-Insight-Solutions/Reckons.AI">github.com/Data-Insight-Solutions/Reckons.AI</a>.</p>

<style>
  .fr-eyebrow { font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); margin: 0 0 0.5rem; }
  .fr-lede { font-size: 1.12rem; line-height: 1.6; color: var(--ink-2); }
  .fr-meta { display: flex; flex-wrap: wrap; gap: 0.35rem 1.1rem; font-family: var(--font-mono); font-size: 0.78rem; color: var(--muted); }
  .fr-figures { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--surface-3); border: 1px solid var(--surface-3); border-radius: 6px; overflow: hidden; margin: 1rem 0; }
  .fr-figures > div { background: var(--surface); padding: 0.9rem 1rem; display: grid; gap: 0.2rem; align-content: start; }
  .fr-figures b { font-family: var(--font-display); font-size: 2rem; line-height: 1.1; color: var(--accent); font-variant-numeric: tabular-nums; }
  .fr-figures span { font-size: 0.9rem; line-height: 1.4; color: var(--muted); }
  .fr-quotes { list-style: none; padding: 0; display: grid; gap: 0.45rem; }
  .fr-quotes li { font-family: var(--font-mono); font-size: 0.88rem; border-left: 3px solid var(--accent); padding: 0.3rem 0 0.3rem 0.8rem; }
  .fr-note { font-size: 0.85rem; color: var(--muted); }
  .fr-chart { background: var(--surface); border: 1px solid var(--surface-3); border-radius: 6px; padding: 1rem; display: grid; gap: 0.5rem; margin: 1rem 0; }
  .fr-row, .fr-axis { display: grid; grid-template-columns: 4.2rem minmax(0, 1fr) 3.4rem; gap: 0.6rem; align-items: center; font-family: var(--font-mono); font-size: 0.78rem; font-variant-numeric: tabular-nums; }
  .fr-row > span:last-child { text-align: right; }
  .fr-row i { display: block; height: 1rem; background: linear-gradient(90deg, var(--surface-3) 1px, transparent 1px) 0 0 / 25% 100%; }
  .fr-row em { display: block; height: 100%; background: var(--muted-2); }
  .fr-now { color: var(--accent); font-weight: 600; }
  .fr-now em { background: var(--accent); }
  .fr-axis { color: var(--muted); font-size: 0.68rem; }
  .fr-axis i { display: flex; justify-content: space-between; font-style: normal; }
  .fr-caution { border-left: 3px solid var(--danger); background: var(--surface); padding: 0.8rem 1rem; border-radius: 0 6px 6px 0; }
  .fr-caution strong { color: var(--danger); }
  .fr-caution p { margin: 0.3rem 0 0; }
  .fr-tiers { display: grid; gap: 0.6rem; margin: 1rem 0; }
  .fr-tiers > div { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 0.8rem; align-items: baseline; background: var(--surface); border: 1px solid var(--surface-3); border-radius: 6px; padding: 0.7rem 0.9rem; }
  .fr-tiers p { margin: 0; }
  .fr-tag { font-family: var(--font-mono); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); background: var(--accent-soft); padding: 0.15rem 0.45rem; border-radius: 3px; justify-self: start; }
  .fr-tag-cloud { color: var(--danger); background: var(--surface-2); }
  @media (max-width: 30rem) {
    .fr-figures { grid-template-columns: minmax(0, 1fr); }
    .fr-tiers > div { grid-template-columns: minmax(0, 1fr); }
    .fr-row, .fr-axis { grid-template-columns: 3.4rem minmax(0, 1fr) 3rem; }
  }
</style>
