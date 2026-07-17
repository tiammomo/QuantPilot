import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

import { getRuntimeDegradationConfig } from '@/lib/config/degradation';
import { prisma } from '@/lib/db/client';

export type ReadinessStatus = 'ok' | 'failed' | 'disabled';

export interface ReadinessComponent {
  name: 'database' | 'marketApi' | 'redis' | 'observability' | 'workspace';
  enabled: boolean;
  required: boolean;
  ok: boolean;
  status: ReadinessStatus;
  latencyMs: number;
}

export interface ReadinessResult {
  ok: boolean;
  service: 'quantpilot-web';
  checkedAt: string;
  components: ReadinessComponent[];
}

interface ProbeDefinition {
  name: ReadinessComponent['name'];
  enabled: boolean;
  required: boolean;
  run: () => Promise<void>;
}

export async function runReadinessProbes(
  definitions: ProbeDefinition[],
  now: () => Date = () => new Date(),
): Promise<ReadinessResult> {
  const components = await Promise.all(definitions.map(async (definition) => {
    if (!definition.enabled) {
      return {
        name: definition.name,
        enabled: false,
        required: definition.required,
        ok: true,
        status: 'disabled',
        latencyMs: 0,
      } satisfies ReadinessComponent;
    }

    const startedAt = performance.now();
    try {
      await definition.run();
      return {
        name: definition.name,
        enabled: true,
        required: definition.required,
        ok: true,
        status: 'ok',
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      } satisfies ReadinessComponent;
    } catch {
      return {
        name: definition.name,
        enabled: true,
        required: definition.required,
        ok: false,
        status: 'failed',
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      } satisfies ReadinessComponent;
    }
  }));

  return {
    ok: components.every((component) => !component.required || component.ok),
    service: 'quantpilot-web',
    checkedAt: now().toISOString(),
    components,
  };
}

async function probeHttp(url: string, timeoutMs = 2_500): Promise<void> {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

async function probeRedis(rawUrl: string, timeoutMs = 2_500): Promise<void> {
  const url = new URL(rawUrl);
  const port = Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379));
  if (!url.hostname || !Number.isInteger(port)) throw new Error('Invalid Redis URL');
  const commands: string[][] = [];
  const password = decodeURIComponent(url.password);
  const username = decodeURIComponent(url.username);
  if (password) commands.push(username ? ['AUTH', username, password] : ['AUTH', password]);
  const database = url.pathname.replace(/^\//, '');
  if (database && database !== '0') commands.push(['SELECT', database]);
  commands.push(['PING']);
  const request = commands.map((command) => [
    `*${command.length}\r\n`,
    ...command.flatMap((part) => [`$${Buffer.byteLength(part)}\r\n`, `${part}\r\n`]),
  ].flat().join('')).join('');

  await new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      socket.write(request);
    };
    const socket = url.protocol === 'rediss:'
      ? tls.connect({ host: url.hostname, port, servername: url.hostname }, onConnect)
      : net.createConnection({ host: url.hostname, port }, onConnect);
    const timer = setTimeout(() => socket.destroy(new Error('Redis readiness timeout')), timeoutMs);
    let response = '';
    let settled = false;
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      const lines = response.split('\r\n').filter(Boolean);
      if (lines.some((line) => line.startsWith('-'))) {
        settled = true;
        socket.destroy();
        reject(new Error('Redis readiness command failed'));
        return;
      }
      if (lines.filter((line) => line.startsWith('+')).length >= commands.length) {
        settled = true;
        socket.end();
        resolve();
      }
    });
    socket.once('error', reject);
    socket.once('close', () => {
      clearTimeout(timer);
      if (!settled) reject(new Error('Redis readiness connection closed early'));
    });
  });
}

export async function getWebReadiness(): Promise<ReadinessResult> {
  const degradation = getRuntimeDegradationConfig();
  const projectsDir = path.isAbsolute(process.env.PROJECTS_DIR || '')
    ? String(process.env.PROJECTS_DIR)
    : path.resolve(
        /* turbopackIgnore: true */ process.cwd(),
        /* turbopackIgnore: true */ process.env.PROJECTS_DIR || './data/projects',
      );
  const marketBaseUrl = (process.env.QUANTPILOT_MARKET_API_URL || 'http://127.0.0.1:8000')
    .replace(/\/$/, '');
  const lokiBaseUrl = (process.env.LOKI_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');

  return runReadinessProbes([
    {
      name: 'database',
      ...degradation.components.database,
      run: async () => {
        await prisma.$queryRaw`SELECT 1`;
      },
    },
    {
      name: 'marketApi',
      ...degradation.components.marketApi,
      run: () => probeHttp(`${marketBaseUrl}/ready`),
    },
    {
      name: 'redis',
      ...degradation.components.redis,
      run: () => probeRedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379'),
    },
    {
      name: 'observability',
      ...degradation.components.observability,
      run: () => probeHttp(`${lokiBaseUrl}/ready`),
    },
    {
      name: 'workspace',
      enabled: true,
      required: true,
      run: () => fs.access(
        /* turbopackIgnore: true */ projectsDir,
        fs.constants.R_OK | fs.constants.W_OK,
      ),
    },
  ]);
}
