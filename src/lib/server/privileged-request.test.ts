import { afterEach, describe, expect, it } from 'vitest';
import { assertPrivilegedMutation, PrivilegedRequestError } from './privileged-request';

const original = {
  token: process.env.QUANTPILOT_ADMIN_TOKEN,
  degradation: process.env.QUANTPILOT_DEGRADATION_MODE,
};

afterEach(() => {
  if (original.token === undefined) delete process.env.QUANTPILOT_ADMIN_TOKEN;
  else process.env.QUANTPILOT_ADMIN_TOKEN = original.token;
  if (original.degradation === undefined) delete process.env.QUANTPILOT_DEGRADATION_MODE;
  else process.env.QUANTPILOT_DEGRADATION_MODE = original.degradation;
});

function request(url = 'http://localhost:3000/api/skills', headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', headers: { host: new URL(url).host, ...headers } });
}

describe('assertPrivilegedMutation', () => {
  it('allows a same-origin loopback development mutation', () => {
    delete process.env.QUANTPILOT_ADMIN_TOKEN;
    process.env.QUANTPILOT_DEGRADATION_MODE = 'auto';
    expect(() => assertPrivilegedMutation(request(undefined, { origin: 'http://localhost:3000' }))).not.toThrow();
  });

  it('uses the browser-facing Host when Next.js normalizes Request.url', () => {
    delete process.env.QUANTPILOT_ADMIN_TOKEN;
    process.env.QUANTPILOT_DEGRADATION_MODE = 'auto';
    const normalizedRequest = new Request('http://localhost:3000/api/skills', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3000',
        origin: 'http://127.0.0.1:3000',
      },
    });
    expect(() => assertPrivilegedMutation(normalizedRequest)).not.toThrow();
  });

  it('rejects cross-origin mutations even on loopback', () => {
    expect(() => assertPrivilegedMutation(request(undefined, { origin: 'http://evil.local' }))).toThrow(PrivilegedRequestError);
  });

  it('requires a matching token whenever one is configured', () => {
    process.env.QUANTPILOT_ADMIN_TOKEN = 'test-admin-token';
    expect(() => assertPrivilegedMutation(request())).toThrowError(/管理令牌/);
    expect(() => assertPrivilegedMutation(request(undefined, { 'x-quantpilot-admin-token': 'test-admin-token' }))).not.toThrow();
  });

  it('fails closed for a non-loopback host without a token', () => {
    delete process.env.QUANTPILOT_ADMIN_TOKEN;
    expect(() => assertPrivilegedMutation(request('https://quantpilot.example/api/skills'))).toThrowError(/非本机写入/);
  });
});
