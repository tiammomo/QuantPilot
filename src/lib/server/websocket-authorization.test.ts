import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  addConnection: vi.fn(),
  ensureHeartbeat: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/server/websocket-manager', () => ({
  ensureHeartbeat: mocks.ensureHeartbeat,
  websocketManager: { addConnection: mocks.addConnection },
}));
vi.mock('ws', () => ({
  WebSocketServer: class WebSocketServer {
    handleUpgrade(_request: unknown, _socket: unknown, _head: unknown, callback: (socket: object) => void) {
      callback({ readyState: 1 });
    }
  },
}));

import { AuthorizationError } from '@/lib/auth/authorization';
import handler from '@/pages/api/ws/[projectId]';

function request() {
  return {
    url: '/api/ws/project-1',
    headers: { host: 'localhost:3000' },
  } as never;
}

function response() {
  const upgradeHandlers: Array<(...args: any[]) => unknown> = [];
  const server = {
    on: vi.fn((event: string, listener: (...args: any[]) => unknown) => {
      if (event === 'upgrade') upgradeHandlers.push(listener);
    }),
  };
  const result: any = {
    socket: { server },
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
  };
  result.status.mockReturnValue(result);
  return { response: result, server, upgradeHandlers };
}

function upgradeSocket() {
  return {
    destroyed: false,
    write: vi.fn(),
    destroy: vi.fn(function destroy(this: { destroyed: boolean }) {
      this.destroyed = true;
    }),
  };
}

describe('WebSocket capability authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({});
  });

  it('authorizes the warm-up request before installing the shared upgrade listener', async () => {
    const target = response();

    await handler(request(), target.response);

    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'project.read',
      projectId: 'project-1',
    });
    expect(target.server.on).toHaveBeenCalledWith('upgrade', expect.any(Function));
  });

  it('does not install an upgrade listener for a denied warm-up request', async () => {
    mocks.requireAction.mockRejectedValueOnce(
      new AuthorizationError('PROJECT_NOT_FOUND', 404, '项目不存在。'),
    );
    const target = response();

    await handler(request(), target.response);

    expect(target.response.status).toHaveBeenCalledWith(404);
    expect(target.server.on).not.toHaveBeenCalled();
  });

  it('re-authorizes the real upgrade and never subscribes a denied project', async () => {
    const target = response();
    await handler(request(), target.response);
    const listener = target.upgradeHandlers[0];
    expect(listener).toBeTypeOf('function');
    mocks.requireAction.mockRejectedValueOnce(
      new AuthorizationError('PROJECT_NOT_FOUND', 404, '项目不存在。'),
    );
    const socket = upgradeSocket();

    await listener!(
      {
        url: '/api/ws/project-1',
        headers: { host: 'localhost:3000', origin: 'http://localhost:3000' },
        socket: {},
      },
      socket,
      Buffer.alloc(0),
    );

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('PROJECT_NOT_FOUND'));
    expect(socket.destroy).toHaveBeenCalled();
    expect(mocks.addConnection).not.toHaveBeenCalled();
  });
});
