#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const failures = [];
const warnings = [];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function assertIncludes(relativePath, terms) {
  if (!exists(relativePath)) {
    fail(`missing required file: ${relativePath}`);
    return;
  }
  const content = read(relativePath);
  for (const term of terms) {
    if (!content.includes(term)) {
      fail(`${relativePath} should mention "${term}"`);
    }
  }
}

function validateCatalog() {
  const catalog = readJson('config/service-catalog.json');
  if (catalog.version !== 1) fail('service catalog version must be 1');
  if (!Array.isArray(catalog.services) || catalog.services.length < 6) {
    fail('service catalog should define the local platform services');
    return;
  }

  const validRuntimes = new Set(['node', 'python', 'rust', 'postgresql', 'redis', 'clickhouse', 'loki', 'grafana', 'alloy']);
  const validKinds = new Set(['application', 'api', 'database', 'cache', 'analytics', 'observability']);
  const validProtocols = new Set(['http', 'postgresql', 'redis']);
  const ids = new Set();
  const dockerCompose = exists('docker-compose.yml') ? read('docker-compose.yml') : '';
  const expectedServices = [
    'web',
    'market-data',
    'memory',
    'knowledge',
    'modelport',
    'timescaledb',
    'redis',
    'clickhouse',
    'loki',
    'grafana',
    'alloy',
  ];

  for (const serviceId of expectedServices) {
    if (!catalog.services.some((service) => service.id === serviceId)) {
      fail(`service catalog missing ${serviceId}`);
    }
  }

  for (const service of catalog.services) {
    if (!/^[a-z][a-z0-9-]*$/.test(service.id)) fail(`invalid service id: ${service.id}`);
    if (ids.has(service.id)) fail(`duplicate service id: ${service.id}`);
    ids.add(service.id);
    if (!service.name || !service.summary) fail(`${service.id} must have name and summary`);
    if (!validRuntimes.has(service.runtime)) fail(`${service.id} has invalid runtime: ${service.runtime}`);
    if (!validKinds.has(service.kind)) fail(`${service.id} has invalid kind: ${service.kind}`);
    if (typeof service.enabledByDefault !== 'boolean') fail(`${service.id} enabledByDefault must be boolean`);
    if (typeof service.requiredByDefault !== 'boolean') fail(`${service.id} requiredByDefault must be boolean`);
    if (!Array.isArray(service.dependencies)) fail(`${service.id} dependencies must be an array`);
    if (!Array.isArray(service.capabilities) || service.capabilities.length === 0) {
      fail(`${service.id} should declare capabilities`);
    }
    if (!service.endpoint || !validProtocols.has(service.endpoint.protocol)) {
      fail(`${service.id} has invalid endpoint protocol`);
    }
    if (!Array.isArray(service.endpoint?.env) || service.endpoint.env.length === 0) {
      fail(`${service.id} endpoint.env must list environment keys`);
    }
    for (const envKey of [service.enabledEnv, service.requiredEnv, ...(service.endpoint?.env ?? [])].filter(Boolean)) {
      if (!/^[A-Z0-9_]+$/.test(envKey)) fail(`${service.id} has invalid env key: ${envKey}`);
    }
    if (service.endpoint?.protocol === 'http' && !service.endpoint.healthPath) {
      warn(`${service.id} has no HTTP healthPath`);
    }
    if (service.endpoint?.healthPath && !service.endpoint.healthPath.startsWith('/')) {
      fail(`${service.id} healthPath must start with /`);
    }
    if (service.dockerService && !dockerCompose.includes(`  ${service.dockerService}:`)) {
      fail(`${service.id} dockerService is not defined in docker-compose.yml: ${service.dockerService}`);
    }
  }

  for (const service of catalog.services) {
    for (const dependency of service.dependencies ?? []) {
      if (!ids.has(dependency)) {
        fail(`${service.id} depends on unknown service: ${dependency}`);
      }
    }
  }

  return catalog;
}

validateCatalog();

assertIncludes('src/lib/platform/service-catalog.ts', [
  'getResolvedServiceCatalog',
  'validateServiceCatalog',
  'buildServiceDependencyEdges',
]);
assertIncludes('src/app/api/infrastructure/service-catalog/route.ts', [
  'getResolvedServiceCatalog',
  'validateServiceCatalog',
]);
assertIncludes('src/lib/ops/ops-platform.ts', [
  'serviceCatalog',
  'serviceDependencyEdges',
  'serviceCatalogValidation',
]);
assertIncludes('docs/infrastructure.md', ['config/service-catalog.json', '服务目录']);
assertIncludes('docs/architecture.md', ['服务目录', 'Python/Node']);
assertIncludes('docs/api-reference.md', ['/api/infrastructure/service-catalog']);

for (const warning of warnings) {
  console.warn(`warning: ${warning}`);
}

if (failures.length) {
  console.error('Service catalog check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Service catalog check passed.');
