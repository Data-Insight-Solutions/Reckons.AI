/**
 * The importable n8n workflow is part of the contract, not documentation.
 *
 * The app POSTs to `{n8nBaseUrl}${CONTACT_WEBHOOK_PATH}`; the workflow listens on a `path` it
 * declares itself. Those two strings live in different files, in different languages, and NOTHING
 * connects them at runtime — a rename on either side produces a form that reports "✓ Sent" while
 * the submission goes nowhere, because a 404 from a webhook that does not exist is indistinguishable
 * from any other network story the user never sees. So the match is pinned here.
 *
 * The second half tests the workflow's own Code node, which formats an email out of a payload that
 * arrived over the OPEN INTERNET. Its job is to keep CR/LF out of mail headers; a test that never
 * feeds it a newline proves nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { CONTACT_WEBHOOK_PATH } from '../contact';

const workflow = JSON.parse(
  readFileSync(path.join(process.cwd(), 'static/n8n/contact-feedback.workflow.json'), 'utf8')
);

const node = (name: string) => workflow.nodes.find((n: any) => n.name === name);

describe('contact-feedback workflow — the app/n8n contract', () => {
  it('the webhook path is exactly what the app POSTs to', () => {
    const webhook = node('Reckons contact webhook');
    expect(webhook).toBeDefined();
    // CONTACT_WEBHOOK_PATH is "/webhook/reckons-contact"; n8n declares the trailing segment only.
    expect(`/webhook/${webhook.parameters.path}`).toBe(CONTACT_WEBHOOK_PATH);
  });

  it('responds on receive, so the form can show "Sent" instead of hanging', () => {
    expect(node('Reckons contact webhook').parameters.responseMode).toBe('onReceived');
  });

  it('emails the address feedback is meant to reach', () => {
    expect(node('Send feedback email').parameters.sendTo).toBe('matthew.roe@data-insight.solutions');
  });

  it('replies go to the submitter, not to the sender of the notification', () => {
    expect(node('Send feedback email').parameters.options.replyTo).toContain('replyTo');
  });
});

/** Run the workflow's Code node the way n8n would, so the logic under test is the shipped string. */
function runFormatNode(body: unknown) {
  const code = node('Validate + format').parameters.jsCode;
  const $input = { first: () => ({ json: { body } }) };
  return new Function('$input', '$json', code)($input, { body })[0].json;
}

describe('contact-feedback workflow — untrusted payload handling', () => {
  it('formats an ordinary submission', () => {
    const out = runFormatNode({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'The graph view is excellent.',
      source: 'about',
      submittedAt: '2026-07-23T10:00:00.000Z',
    });
    expect(out.valid).toBe(true);
    expect(out.subject).toBe('Reckons.AI feedback from Ada Lovelace (about)');
    expect(out.replyTo).toBe('ada@example.com');
    expect(out.body).toContain('The graph view is excellent.');
  });

  it('STRIPS CR/LF from the subject — header injection is the reason this node exists', () => {
    const out = runFormatNode({
      name: 'Ada\r\nBcc: attacker@evil.example',
      email: 'ada@example.com',
      message: 'hello',
    });
    expect(out.subject).not.toContain('\r');
    expect(out.subject).not.toContain('\n');
    expect(out.subject).toContain('Bcc: attacker@evil.example'); // flattened into the subject text…
    expect(out.subject.split('\n')).toHaveLength(1); // …never as a second header line.
  });

  it('refuses a malformed address for Reply-To rather than passing it to a header', () => {
    const out = runFormatNode({
      name: 'X',
      email: 'not\r\nan@address',
      message: 'hello',
    });
    expect(out.replyTo).toBe('');
    expect(out.body).toContain('no usable address supplied');
  });

  it('keeps newlines in the BODY — only headers are flattened', () => {
    const out = runFormatNode({ name: 'A', email: 'a@b.co', message: 'line one\nline two' });
    expect(out.body).toContain('line one\nline two');
  });

  it('drops an empty message', () => {
    expect(runFormatNode({ name: 'A', email: 'a@b.co', message: '   ' }).valid).toBe(false);
  });

  it('drops an oversized message — the open webhook will attract junk', () => {
    expect(runFormatNode({ name: 'A', email: 'a@b.co', message: 'x'.repeat(20001) }).valid).toBe(false);
  });

  it('survives a payload missing every optional field', () => {
    const out = runFormatNode({ message: 'just a message' });
    expect(out.valid).toBe(true);
    expect(out.subject).toContain('anonymous');
    expect(out.replyTo).toBe('');
  });
});
