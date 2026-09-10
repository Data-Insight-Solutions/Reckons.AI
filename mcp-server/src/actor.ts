/**
 * WHO IS SETTLING THIS — captured from the environment, never accepted from the caller (F199).
 *
 * Matt, 2026-09-10: "We could ask who is currently using CLI, record local system user, etc?"
 * Correct, and it fixes a real weakness in the first draft of the review procedure, where the
 * verdict carried `by: string` supplied by whoever called the tool. A field the caller fills in
 * is a claim about identity, and this file's whole job is to replace it with an OBSERVATION.
 *
 * WHAT THIS ESTABLISHES:
 *   - the OS account and machine the verdict was written from, read from the process rather than
 *     from an argument, so a caller cannot sign a verdict as somebody else without becoming them;
 *   - whether an AI AGENT was in the loop, which the environment reports independently of the
 *     caller (CLAUDECODE / AI_AGENT / CLAUDE_CODE_SESSION_ID are set by the harness, not by the
 *     tool call), and which is the distinction that actually matters here;
 *   - for the CLI, whether a human was at an interactive terminal, from isTTY.
 *
 * WHAT IT DOES NOT ESTABLISH, AND THE DISTANCE IS NOT SMALL. The OS user is the account the
 * process RUNS AS. An agent running as `matt` reports `matt`, because it is matt's shell, matt's
 * machine and matt's session — that is not a spoof, it is what the account means. So this can
 * never prove that a person typed the words. It can prove the machine and the account, and it can
 * report honestly that an agent was present, which is enough to make the one failure this system
 * really has to catch — an agent settling its own proposals and it looking exactly like a human
 * decision — VISIBLE rather than silent. Nothing here is a credential.
 *
 * THE MCP ROUTE CANNOT CLAIM A HUMAN AT ALL, BY CONSTRUCTION: an MCP tool call is made by a model.
 * The most it can say is that the human's account authorised the session that relayed the
 * instruction, and that is exactly what it says.
 */

import { hostname, userInfo } from 'node:os';

export type Route = 'cli' | 'mcp';

export interface Actor {
  /** OS account the process runs as. Observed, not supplied. */
  user: string;
  host: string;
  route: Route;
  /**
   * True when the harness says an AI agent is running this process. Set by the environment, so a
   * tool call cannot deny it — which is the point, since denying it is what a caller would do.
   */
  agent: boolean;
  /** The agent session, when the harness names one — ties a verdict to a readable transcript. */
  session?: string;
  /**
   * WHICH agent, when one is present — not merely that one is.
   *
   * The boolean above says an AI is in the loop; this says WHO, so it can be compared against the
   * `agent` that PROPOSED a row. That comparison is the whole of the self-settlement check: F52
   * exists to stop a machine asserting its own claims as established, and an agent accepting a
   * proposal it wrote itself is precisely that, wearing a person's account.
   */
  agentId?: string;
  /** CLI only: a human at an interactive terminal. Evidence, not proof — a PTY can be allocated. */
  interactive?: boolean;
  /**
   * A one-line, honest summary of the above, written into the journal so a future reader does not
   * have to reconstruct the rules from the fields.
   */
  attestation: string;
}

/** Environment variables the harness sets. A caller CAN clear them; clearing them removes a claim of authority, never adds one. */
function agentPresent(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CLAUDECODE || env.AI_AGENT || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_CODE_ENTRYPOINT);
}

export function currentActor(route: Route, env: NodeJS.ProcessEnv = process.env): Actor {
  let user: string;
  try {
    user = userInfo().username;
  } catch {
    // userInfo() throws when the uid has no passwd entry — containers do this routinely.
    user = env.LOGNAME || env.USER || `uid:${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}`;
  }

  let host: string;
  try { host = hostname(); } catch { host = 'unknown-host'; }

  const agent = agentPresent(env);
  const session = env.CLAUDE_CODE_SESSION_ID || undefined;
  // `claude-code` is the same string offline jobs and MCP clients write into a row's `agent`
  // field, so the two are directly comparable without a mapping table to fall out of date.
  const agentId = agent
    ? (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_CODE_ENTRYPOINT ? 'claude-code' : 'unknown-agent')
    : undefined;
  const interactive = route === 'cli' ? Boolean(process.stdin.isTTY) : undefined;

  return {
    user, host, route, agent, session, interactive,
    ...(agentId ? { agentId } : {}),
    attestation: attest({ user, host, route, agent, interactive }),
  };
}

/**
 * The sentence that goes in the journal beside the verdict.
 *
 * Deliberately says what is NOT known. A log line reading `by: matt` invites a reader to believe
 * a person decided; these say which of those words were observed and which were inferred.
 */
function attest(a: Pick<Actor, 'user' | 'host' | 'route' | 'agent' | 'interactive'>): string {
  const where = `${a.user}@${a.host}`;
  if (a.route === 'mcp') {
    return a.agent
      ? `Recorded by an AI agent over MCP, in a session authorised by ${where}. A model made this call; the account did not type it.`
      : `Recorded over MCP by a client running as ${where}. MCP calls are made by programs, so no person typed this directly.`;
  }
  if (a.agent) {
    return `Recorded by the CLI running as ${where}, in a process the harness reports as an AI agent. Not a person at a keyboard.`;
  }
  if (a.interactive) {
    return `Typed at an interactive terminal as ${where}. Consistent with a person, and not proof of one — a PTY can be allocated.`;
  }
  return `Recorded by the CLI as ${where}, non-interactively (piped or scripted). No person was at a keyboard for this call.`;
}

/** Short form for a terminal line: `matt@12chi-core via mcp (agent)`. */
export function actorLine(a: Actor): string {
  const marks = [a.agent ? 'agent' : null, a.interactive ? 'tty' : null].filter(Boolean).join(', ');
  return `${a.user}@${a.host} via ${a.route}${marks ? ` (${marks})` : ''}`;
}
