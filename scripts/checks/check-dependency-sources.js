#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

function inspectDependencySources(lock) {
  const failures = [];
  let packages = 0;
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    return { packages, failures: ['Expected an npm v3 lockfile with package entries.'] };
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    packages += 1;
    let url;
    try { url = new URL(entry.resolved); } catch { /* Report the package, never an untrusted URL. */ }
    if (!url || url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org'
      || url.port || url.username || url.password || url.search || url.hash
      || !url.pathname.endsWith('.tgz')) {
      failures.push(`${name}: package must resolve to the official npm registry.`);
    }
    if (typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) {
      failures.push(`${name}: SHA-512 integrity is required.`);
    }
  }
  return { packages, failures };
}

if (require.main === module) {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package-lock.json'), 'utf8'));
  const result = inspectDependencySources(lock);
  if (result.failures.length) {
    result.failures.forEach((failure) => console.error(`[dependency-sources] ${failure}`));
    process.exitCode = 1;
  } else {
    console.log(`[dependency-sources] ${result.packages} packages use npm registry tarballs with SHA-512 integrity.`);
  }
}

module.exports = { inspectDependencySources };
