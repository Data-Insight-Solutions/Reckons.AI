/** JSON contracts shared by scripted workflows and screenshot-guided exploration. */
export type Assertion = { path?: string; selector?: string; text?: string };
export type ScriptStep = { action: 'goto'; path: string } |
  { action: 'click'; selector: string } | { action: 'fill'; selector: string; text: string };
export type Action = { action: 'click'; target: number; reason: string } |
  { action: 'fill'; target: number; text: string; reason: string } |
  { action: 'press'; key: 'Tab' | 'Enter' | 'Escape' | 'ArrowDown' | 'ArrowUp'; reason: string } |
  { action: 'scroll'; delta: number; reason: string } |
  { action: 'finish'; reason: string };
export type Review = { verdict: 'ok' | 'issue' | 'uncertain'; detail: string };
export type Lens = { id: string; question: string };
export type Stream = {
  id: string; mode: 'scripted' | 'explore'; goal: string; startPath: string; model: string;
  viewport: { width: number; height: number }; mobile: boolean;
  maxSteps: number; timeoutMs: number; lenses: Lens[]; steps: ScriptStep[]; assertions: Assertion[];
};
type Obj = Record<string, unknown>;
const reasonSchema = { type: 'string', minLength: 1, maxLength: 2000 };
export const reviewSchema = { type: 'object', additionalProperties: false, required: ['verdict', 'detail'],
  properties: { verdict: { enum: ['ok', 'issue', 'uncertain'] }, detail: reasonSchema } };
/** Give the model the precise contract; runtime validation remains authoritative. */
export function actionSchema(ids: number[]) {
  const variant = (action: string, fields: Obj = {}) => ({ type: 'object', additionalProperties: false,
    required: ['action', 'reason', ...Object.keys(fields)], properties: { action: { const: action }, reason: reasonSchema, ...fields } });
  return { oneOf: [
    ...(ids.length ? [variant('click', { target: { enum: ids } }),
      variant('fill', { target: { enum: ids }, text: { type: 'string', minLength: 1, maxLength: 1000 } })] : []),
    variant('press', { key: { enum: ['Tab', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp'] } }),
    variant('scroll', { delta: { type: 'integer', minimum: -900, maximum: 900 } }), variant('finish'),
  ] };
}
function object(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected an object');
  return v as Obj;
}
function keys(v: Obj, allowed: string[]) {
  for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new Error(`Unknown field: ${key}`);
}
function str(v: unknown, max = 2000): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error('Expected bounded nonempty text');
  return v;
}
function integer(v: unknown, min: number, max: number): number {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Error(`Expected integer ${min}..${max}`);
  return v as number;
}
function list(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new Error(`Expected array of at most ${max} items`);
  return v;
}
function id(v: unknown): string {
  const s = str(v, 80);
  if (!/^[a-z][a-z0-9-]*$/.test(s)) throw new Error('Expected a lowercase slug');
  return s;
}
export function localOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an explicit loopback HTTP origin without credentials, path or query');
  }
  return url.origin;
}
export function appPath(value: unknown): string {
  const p = str(value);
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\') || /[\u0000-\u0020]/.test(p)) throw new Error('Expected an app-relative path');
  return p;
}
export function parseAction(raw: string, targetIds: number[]): Action {
  const v = object(JSON.parse(raw));
  const reason = str(v.reason);
  switch (v.action) {
    case 'click': case 'fill': {
      keys(v, v.action === 'click' ? ['action', 'target', 'reason'] : ['action', 'target', 'text', 'reason']);
      const target = integer(v.target, 1, 100);
      if (!targetIds.includes(target)) throw new Error(`Target ${target} was not visible in this frame`);
      return v.action === 'click' ? { action: 'click', target, reason } : { action: 'fill', target, text: str(v.text, 1000), reason };
    }
    case 'press':
      keys(v, ['action', 'key', 'reason']);
      if (!['Tab', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp'].includes(String(v.key))) throw new Error('Key not allowed');
      return { action: 'press', key: v.key as Extract<Action, { action: 'press' }>['key'], reason };
    case 'scroll':
      keys(v, ['action', 'delta', 'reason']);
      return { action: 'scroll', delta: integer(v.delta, -900, 900), reason };
    case 'finish':
      keys(v, ['action', 'reason']);
      return { action: 'finish', reason };
    default: throw new Error('Unknown action');
  }
}
export function parseReview(raw: string): Review {
  const v = object(JSON.parse(raw));
  keys(v, ['verdict', 'detail']);
  if (!['ok', 'issue', 'uncertain'].includes(String(v.verdict))) throw new Error('Unknown review verdict');
  return { verdict: v.verdict as Review['verdict'], detail: str(v.detail) };
}
export function parseStreams(input: unknown): Stream[] {
  const root = object(input);
  keys(root, ['version', 'streams']);
  if (root.version !== 1) throw new Error('Expected stream contract version 1');
  const streams = list(root.streams, 30).map(raw => {
    const v = object(raw);
    keys(v, ['id', 'mode', 'goal', 'startPath', 'model', 'viewport', 'mobile', 'maxSteps', 'timeoutMs', 'lenses', 'steps', 'assertions']);
    if (v.mode !== 'scripted' && v.mode !== 'explore') throw new Error('Expected scripted or explore mode');
    const viewport = object(v.viewport ?? { width: 1280, height: 800 });
    keys(viewport, ['width', 'height']);
    if (v.mobile !== undefined && typeof v.mobile !== 'boolean') throw new Error('mobile must be boolean');
    const lenses = list(v.lenses, 8).map(raw => {
      const lens = object(raw); keys(lens, ['id', 'question']);
      return { id: id(lens.id), question: str(lens.question) };
    });
    if (!lenses.length || new Set(lenses.map(l => l.id)).size !== lenses.length) throw new Error('Provide distinct analysis lenses');
    const steps = list(v.steps ?? [], 40).map((raw): ScriptStep => {
      const step = object(raw);
      if (step.action === 'goto') { keys(step, ['action', 'path']); return { action: 'goto', path: appPath(step.path) }; }
      if (step.action === 'click') { keys(step, ['action', 'selector']); return { action: 'click', selector: str(step.selector) }; }
      if (step.action === 'fill') { keys(step, ['action', 'selector', 'text']); return { action: 'fill', selector: str(step.selector), text: str(step.text, 1000) }; }
      throw new Error('Invalid scripted action');
    });
    if ((v.mode === 'scripted' && !steps.length) || (v.mode === 'explore' && steps.length)) throw new Error('Only scripted streams require steps');
    const maxSteps = integer(v.maxSteps ?? (v.mode === 'scripted' ? steps.length : 12), 1, 40);
    if (steps.length > maxSteps) throw new Error('Scripted steps exceed maxSteps');
    const assertions = list(v.assertions ?? [], 20).map(raw => {
      const a = object(raw); keys(a, ['path', 'selector', 'text']);
      if (!a.path && !a.selector) throw new Error('Assertion needs path or selector');
      if (a.text !== undefined && !a.selector) throw new Error('Text assertions need a selector');
      return { ...(a.path === undefined ? {} : { path: appPath(a.path) }),
        ...(a.selector === undefined ? {} : { selector: str(a.selector) }), ...(a.text === undefined ? {} : { text: str(a.text) }) };
    });
    return { id: id(v.id), mode: v.mode, goal: str(v.goal), startPath: appPath(v.startPath), model: str(v.model ?? 'qwen2.5vl:7b', 150),
      viewport: { width: integer(viewport.width, 320, 1920), height: integer(viewport.height, 320, 1400) }, mobile: v.mobile ?? false,
      maxSteps, timeoutMs: integer(v.timeoutMs ?? 600000, 1000, 3600000), lenses, steps, assertions } as Stream;
  });
  if (!streams.length || new Set(streams.map(s => s.id)).size !== streams.length) throw new Error('Provide distinct streams');
  return streams;
}
