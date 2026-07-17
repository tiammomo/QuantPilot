const { spawn, spawnSync } = require('node:child_process');

function databaseEnvironment(rawUrl = process.env.DATABASE_URL) {
  if (!rawUrl) throw new Error('DATABASE_URL is required');
  const url = new URL(rawUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL must include a database name');
  return {
    database,
    env: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: database,
      ...(url.searchParams.get('sslmode')
        ? { PGSSLMODE: url.searchParams.get('sslmode') }
        : {}),
    },
  };
}

function requireCommand(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  if (result.status !== 0) {
    throw new Error(`${command} is required on the release host`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? 'null'}, signal ${signal ?? 'null'}`));
    });
  });
}

module.exports = { databaseEnvironment, requireCommand, run };
