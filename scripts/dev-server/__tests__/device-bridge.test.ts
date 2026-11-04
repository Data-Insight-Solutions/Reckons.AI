import { describe, expect, it } from 'vitest';
import { isTrustedRequest, mcpServers } from '../device-bridge.js';

describe('isTrustedRequest', () => {
  it('accepts loopback GETs, including 127.0.0.1 and bracketed IPv6', () => {
    expect(isTrustedRequest({ method: 'GET', host: 'localhost:5173' })).toBe(true);
    expect(isTrustedRequest({ method: 'GET', host: '127.0.0.1:5173' })).toBe(true);
    expect(isTrustedRequest({ method: 'GET', host: '[::1]:5173' })).toBe(true);
  });

  it('refuses a non-loopback Host (DNS rebinding) and a missing one', () => {
    expect(isTrustedRequest({ method: 'GET', host: 'evil.example.com' })).toBe(false);
    expect(isTrustedRequest({ method: 'GET' })).toBe(false);
  });

  it('refuses a cross-site fetch even with a loopback Host', () => {
    expect(isTrustedRequest({ method: 'GET', host: 'localhost:5173', secFetchSite: 'cross-site' })).toBe(false);
  });

  it('POSTs need an Origin naming the same host', () => {
    expect(isTrustedRequest({ method: 'POST', host: 'localhost:5173' })).toBe(false);
    expect(isTrustedRequest({ method: 'POST', host: 'localhost:5173', origin: 'http://evil.example.com' })).toBe(false);
    expect(isTrustedRequest({ method: 'POST', host: 'localhost:5173', origin: 'http://localhost:5173' })).toBe(true);
    expect(isTrustedRequest({ method: 'POST', host: 'localhost:5173', origin: 'http://localhost:5174' })).toBe(false);
  });
});

describe('mcpServers', () => {
  it('names each server and how it is reached, never its args, env or headers', () => {
    const result = mcpServers({
      mcpServers: {
        a: { command: '/usr/bin/bash', args: ['--token', 'SECRET'], env: { KEY: 'SECRET' } },
        b: { type: 'http', url: 'https://n8n.example.com/mcp', headers: { Authorization: 'Bearer SECRET' } },
      },
    });
    expect(result).toEqual([
      { name: 'a', transport: 'stdio', via: 'bash' },
      { name: 'b', transport: 'http', via: 'n8n.example.com' },
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('no servers, no list', () => {
    expect(mcpServers({})).toEqual([]);
  });
});
