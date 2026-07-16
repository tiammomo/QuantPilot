import type { NextApiRequest, NextApiResponse } from 'next';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server as HTTPServer } from 'http';
import type { Socket } from 'net';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { getProjectAuthConfig } from '@/lib/config/auth';
import { ensureHeartbeat, websocketManager } from '@/lib/server/websocket-manager';

type NextApiResponseWithSocket = NextApiResponse & {
  socket: Socket & {
    server: HTTPServer & {
      wss?: WebSocketServer;
      __ws_initialized__?: boolean;
    };
  };
};

export const config = {
  api: {
    bodyParser: false,
  },
};

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function rejectUpgrade(socket: Socket, status: 401 | 403, message: string) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: message });
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n` +
    'Content-Type: application/json; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n\r\n' +
    body,
  );
  socket.destroy();
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(',')[0]?.trim() || null;
}

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseWebSocketProjectId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/ws\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    const projectId = decodeURIComponent(match[1]);
    if (
      projectId.length === 0 ||
      projectId.length > 200 ||
      projectId === '.' ||
      projectId === '..' ||
      /[\\/\u0000-\u001f\u007f]/.test(projectId)
    ) {
      return null;
    }
    return projectId;
  } catch {
    return null;
  }
}

export function isAllowedWebSocketOrigin(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
  trustedOrigins: string[],
): boolean {
  const requestOrigin = firstHeaderValue(request.headers.origin);
  if (!requestOrigin) return false;
  const normalizedRequestOrigin = normalizedOrigin(requestOrigin);
  if (!normalizedRequestOrigin) return false;

  const normalizedTrustedOrigins = trustedOrigins
    .map(normalizedOrigin)
    .filter((origin): origin is string => Boolean(origin));
  if (normalizedTrustedOrigins.includes(normalizedRequestOrigin)) return true;

  const host = firstHeaderValue(request.headers.host);
  if (!host) return false;
  const forwardedProtocol = firstHeaderValue(request.headers['x-forwarded-proto']);
  const encrypted = Boolean((request.socket as Socket & { encrypted?: boolean }).encrypted);
  const protocol = forwardedProtocol === 'https' || forwardedProtocol === 'http'
    ? forwardedProtocol
    : encrypted
      ? 'https'
      : 'http';
  return normalizedRequestOrigin === normalizedOrigin(`${protocol}://${host}`);
}

export default async function handler(req: NextApiRequest, res: NextApiResponseWithSocket) {
  // Initialize a shared WebSocket server on the underlying HTTP server once.
  const baseSocket = res.socket as any;
  if (!baseSocket?.server) {
    res.status(500).send('Socket server unavailable');
    return;
  }

  const requestPath = new URL(req.url ?? '', 'http://localhost').pathname;
  const requestProjectId = parseWebSocketProjectId(requestPath);
  if (!requestProjectId) {
    res.status(400).json({ error: 'INVALID_WEBSOCKET_PATH' });
    return;
  }
  try {
    await requireAction({
      headers: requestHeaders(req),
      action: 'project.read',
      projectId: requestProjectId,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }
    res.status(500).json({ error: 'WEBSOCKET_AUTHORIZATION_UNAVAILABLE' });
    return;
  }

  const server = baseSocket.server as typeof baseSocket.server & {
    wss?: WebSocketServer;
    __ws_initialized__?: boolean;
  };

  if (!server.__ws_initialized__) {
    const wss = new WebSocketServer({ noServer: true });

    // Attach a single upgrade listener to the HTTP server
    server.on('upgrade', async (request: IncomingMessage, socket: Socket, head: Buffer) => {
      try {
        const upgradeUrl = new URL(request.url ?? '', 'http://localhost');

        // Only handle our WS endpoint namespace; let Next.js handle HMR and
        // unrelated upgrade protocols.
        if (
          upgradeUrl.pathname !== '/api/ws' &&
          !upgradeUrl.pathname.startsWith('/api/ws/')
        ) {
          return; // Let Next.js handle other upgrades (HMR, etc.)
        }

        const projectId = parseWebSocketProjectId(upgradeUrl.pathname);
        if (!projectId) {
          rejectUpgrade(socket, 403, 'INVALID_WEBSOCKET_PATH');
          return;
        }

        const authConfig = getProjectAuthConfig();
        if (!isAllowedWebSocketOrigin(request, authConfig.trustedOrigins)) {
          rejectUpgrade(socket, 403, 'INVALID_REQUEST_ORIGIN');
          return;
        }

        try {
          await requireAction({
            headers: requestHeaders(request),
            action: 'project.read',
            projectId,
          });
        } catch (error) {
          if (error instanceof AuthorizationError) {
            rejectUpgrade(
              socket,
              error.status === 401 ? 401 : 403,
              error.code,
            );
            return;
          }
          rejectUpgrade(socket, 403, 'WEBSOCKET_AUTHORIZATION_UNAVAILABLE');
          return;
        }

        wss.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
          // projectId is parsed exactly once and reused for authorization and
          // subscription, preventing first/last-path-segment confusion.
          websocketManager.addConnection(projectId, websocket as any);
        });
      } catch {
        try {
          socket.destroy();
        } catch {
          // Ignore socket destroy failures
        }
      }
    });

    server.wss = wss;
    server.__ws_initialized__ = true;
    ensureHeartbeat();
  }

  // When the browser initiates the WebSocket handshake it sends an Upgrade request.
  // The actual upgrade is handled in the server.on('upgrade') listener above,
  // so we must not attempt to write a normal HTTP response here.
  if (req.headers.upgrade?.toLowerCase() === 'websocket') {
    return;
  }

  // This API route is only used to ensure the server is initialized.
  // Respond with a simple 200 so the client knows the endpoint exists.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({ ok: true });
}
