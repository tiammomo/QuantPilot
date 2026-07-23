#!/usr/bin/env node

import net from 'node:net';

const [socketPath, rawPort] = process.argv.slice(2);
const listenPort = Number.parseInt(rawPort ?? '', 10);

if (!socketPath || !Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
  console.error('usage: market-network-bridge.mjs <unix-socket> <listen-port>');
  process.exit(64);
}

const connections = new Set();
const server = net.createServer((client) => {
  const upstream = net.createConnection({ path: socketPath });
  connections.add(client);
  connections.add(upstream);
  const closePair = () => {
    client.destroy();
    upstream.destroy();
    connections.delete(client);
    connections.delete(upstream);
  };
  client.on('error', closePair);
  upstream.on('error', closePair);
  client.on('close', () => connections.delete(client));
  upstream.on('close', () => connections.delete(upstream));
  client.pipe(upstream);
  upstream.pipe(client);
});

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const connection of connections) connection.destroy();
  server.close(() => process.exit(exitCode));
  const forcedExit = setTimeout(() => process.exit(exitCode), 1_000);
  forcedExit.unref();
}

server.on('error', (error) => {
  console.error(`[market-network-bridge] ${error.message}`);
  stop(1);
});
server.listen(listenPort, '127.0.0.1');

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
