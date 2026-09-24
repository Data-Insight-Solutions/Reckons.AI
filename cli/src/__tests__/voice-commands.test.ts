/**
 * Spoken command recognition (F99).
 *
 * THE TESTS THAT MATTER ARE THE ONES ABOUT NOT FIRING. Recognising "stats" is easy; the reason this
 * module exists is that a misheard sentence must never start an agent, save a note, or publish a
 * graph. Every case below with REFUSE or confirm in its name is guarding that.
 *
 * The alias cases use REAL transcripts from the captured-notes corpus, not invented ones — a test
 * built on what an STT engine imaginably does is worth nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  COMMANDS, STT_ALIASES, describeMatch, expandAliases, matchCommand, normalizeUtterance,
  readConfirmation,
} from '../voice-commands.js';

describe('normalisation', () => {
  it('strips punctuation, casing and safe filler', () => {
    expect(normalizeUtterance('  Um, STATS.  ')).toBe('stats');
    expect(normalizeUtterance('uh, what is my priority?')).toBe('what is my priority');
  });

  it('does NOT strip words that could be part of an argument', () => {
    // "like" and "so" are filler in speech and meaningful in a query. Eating them corrupts the
    // search rather than improving the match.
    expect(normalizeUtterance('look up like buttons')).toBe('look up like buttons');
    expect(normalizeUtterance('search for so what happened')).toContain('so what happened');
  });
});

describe('STT aliases — the real manglings', () => {
  it('recovers n8n from what the pipeline actually transcribed', () => {
    // Verbatim from Matt's captured note, 2026-09-10.
    expect(expandAliases('nate and server should be able to relay')).toContain('n8n server');
  });

  it('recovers "voice" from ViaVoice, also observed', () => {
    expect(expandAliases('viavoice')).toBe('voice');
    expect(expandAliases('via voice')).toBe('voice');
  });

  it('applies the longest alias first, so a short one cannot pre-empt it', () => {
    // 'nate and' -> n8n must win over 'nate' -> n8n leaving a stray "and".
    expect(expandAliases('nate and')).toBe('n8n');
  });

  it('handles the product name, which no engine has a prior for', () => {
    for (const said of ['reckons ai', 'reckon zai', 'wreckons']) {
      expect(expandAliases(said)).toContain('reckons');
    }
  });

  it('every alias maps to something shorter or equal, so expansion cannot loop', () => {
    for (const [spoken, meant] of STT_ALIASES) {
      expect(expandAliases(meant)).toBe(expandAliases(expandAliases(meant)));
      expect(spoken).not.toBe(meant);
    }
  });
});

describe('read commands answer immediately', () => {
  it('matches a bare command', () => {
    const m = matchCommand('stats');
    expect(m?.command.id).toBe('stats');
    expect(m?.confirm).toBe(false);
  });

  it('captures the argument and does not keep the command word', () => {
    const m = matchCommand('search for water damage');
    expect(m?.command.id).toBe('search');
    expect(m?.arg).toBe('water damage');
  });

  it('prefers the longer phrase, so "search for" beats "search"', () => {
    expect(matchCommand('search for badgers')?.arg).toBe('badgers');
  });

  it('survives filler and punctuation around a real command', () => {
    expect(matchCommand('Um, tell me about the Lions Club.')?.command.id).toBe('entity');
  });
});

describe('act commands must confirm — the part that matters', () => {
  it('does not fire an agent task; it asks first', () => {
    const m = matchCommand('run the agent on the food tokens graph');
    expect(m?.command.id).toBe('run-agent-task');
    expect(m?.confirm).toBe(true);
    expect(describeMatch(m!)).toMatch(/say yes to start/i);
  });

  it('states what will happen, not just "confirm?"', () => {
    const m = matchCommand('publish the graph');
    // A person agreeing out loud must hear the consequence, because they cannot see a dialogue.
    expect(describeMatch(m!)).toMatch(/readable by other people/i);
  });

  it('marks every act command as needing confirmation, with a prompt', () => {
    for (const c of COMMANDS.filter((c) => c.consequence === 'act')) {
      expect(c.confirmPrompt, `${c.id} has no confirmPrompt`).toBeTruthy();
    }
  });

  it('marks no read command as needing confirmation', () => {
    for (const c of COMMANDS.filter((c) => c.consequence === 'read')) {
      expect(c.confirmPrompt).toBeUndefined();
    }
  });
});

describe('REFUSALS — a fragment is not a command', () => {
  it('refuses an act command with no argument rather than firing it empty', () => {
    // "run the agent" with nothing after it must not start anything.
    expect(matchCommand('run the agent')).toBeNull();
    expect(matchCommand('make a note')).toBeNull();
  });

  it('refuses a command that is not at the start of the utterance', () => {
    // Otherwise any sentence containing "stop" or "publish the graph" becomes a command.
    expect(matchCommand('I was going to publish the graph tomorrow')).toBeNull();
    expect(matchCommand('could you please search for badgers')).toBeNull();
  });

  it('returns null on an empty or filler-only transcript', () => {
    expect(matchCommand('')).toBeNull();
    expect(matchCommand('um uh hmm')).toBeNull();
  });

  it('does not match a command word buried in a note body', () => {
    expect(matchCommand('we talked about how to publish the graph next season')).toBeNull();
  });
});

describe('confirmation replies', () => {
  it('accepts clear affirmatives and refusals', () => {
    expect(readConfirmation('yes')).toBe('yes');
    expect(readConfirmation('Go ahead.')).toBe('yes');
    expect(readConfirmation('cancel')).toBe('no');
  });

  it('treats ANYTHING unclear as unclear, never as yes', () => {
    // The two failure directions are not symmetric: re-asking costs a sentence, guessing yes runs
    // something nobody asked for.
    for (const said of ['hm', 'maybe', 'i think so', 'yes but not that one', '', 'what']) {
      expect(readConfirmation(said), `"${said}" must not read as yes`).not.toBe('yes');
    }
  });

  it('does not read a longer sentence containing "yes" as consent', () => {
    expect(readConfirmation('yes I was saying earlier')).toBe('unclear');
  });
});
