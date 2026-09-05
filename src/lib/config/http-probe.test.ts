import { createServer, type RequestListener, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { probeHttp } = require('../../../scripts/shared/http-probe.js') as {
  probeHttp(url: string, options?: { json?: boolean; timeoutMs?: number }): Promise<{
    ok: boolean; statusCode: number | null; data?: unknown; error?: string;
  }>;
};
let server: Server;
async function listen(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('doctor HTTP probes', () => {
  it('preserves status and JSON from a service', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ready: false }));
    });
    expect(await probeHttp(url, { json: true })).toEqual({
      ok: false, statusCode: 503, data: { ready: false },
    });
  });

  it('times out a service that never sends headers', async () => {
    const url = await listen(() => {});
    expect(await probeHttp(url, { timeoutMs: 100 })).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('enforces a total deadline even while the response keeps sending data', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{');
      const timer = setInterval(() => response.write(' '), 10);
      response.on('close', () => clearInterval(timer));
    });
    const started = performance.now();
    expect(await probeHttp(url, { json: true, timeoutMs: 150 })).toMatchObject({
      ok: false, statusCode: 200, error: 'timeout',
    });
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
