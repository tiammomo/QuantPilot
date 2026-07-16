import { describe, expect, it } from 'vitest';

import {
  isAllowedWebSocketOrigin,
  parseWebSocketProjectId,
} from '@/pages/api/ws/[projectId]';

function upgradeRequest(headers: Record<string, string>) {
  return {
    headers,
    socket: {},
  } as never;
}

describe('WebSocket upgrade boundary', () => {
  it('accepts exactly one project path segment', () => {
    expect(parseWebSocketProjectId('/api/ws/project-123')).toBe('project-123');
    expect(parseWebSocketProjectId('/api/ws/project_123/')).toBe('project_123');
    expect(parseWebSocketProjectId('/api/ws/project-a/other-project')).toBeNull();
    expect(parseWebSocketProjectId('/api/ws/project-a%2Fother-project')).toBeNull();
    expect(parseWebSocketProjectId('/api/ws/..')).toBeNull();
    expect(parseWebSocketProjectId('/api/ws/')).toBeNull();
  });

  it('accepts only the request host or an explicitly trusted origin', () => {
    expect(isAllowedWebSocketOrigin(upgradeRequest({
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
    }), [])).toBe(true);

    expect(isAllowedWebSocketOrigin(upgradeRequest({
      host: 'internal:3000',
      origin: 'https://app.example.com',
      'x-forwarded-host': 'app.example.com',
      'x-forwarded-proto': 'https',
    }), ['https://app.example.com'])).toBe(true);

    expect(isAllowedWebSocketOrigin(upgradeRequest({
      host: 'localhost:3000',
      origin: 'https://trusted.example.com',
    }), ['https://trusted.example.com'])).toBe(true);

    expect(isAllowedWebSocketOrigin(upgradeRequest({
      host: 'localhost:3000',
      origin: 'https://attacker.example.com',
      'x-forwarded-host': 'attacker.example.com',
      'x-forwarded-proto': 'https',
    }), [])).toBe(false);
    expect(isAllowedWebSocketOrigin(upgradeRequest({
      host: 'localhost:3000',
    }), [])).toBe(false);
  });
});
