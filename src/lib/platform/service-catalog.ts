import catalogJson from '../../../config/service-catalog.json';

export type ServiceRuntime =
  | 'node'
  | 'python'
  | 'rust'
  | 'postgresql'
  | 'redis'
  | 'clickhouse'
  | 'loki'
  | 'grafana'
  | 'alloy';

export type ServiceKind =
  | 'application'
  | 'api'
  | 'database'
  | 'cache'
  | 'analytics'
  | 'observability';

export type ServiceLifecycle = 'core' | 'supporting';
export type EndpointProtocol = 'http' | 'postgresql' | 'redis';
export type EndpointSource = 'env' | 'default' | 'missing';
export type ServiceConfigurationStatus = 'ok' | 'warning' | 'failed' | 'disabled';

export interface ServiceEndpointDefinition {
  protocol: EndpointProtocol;
  env: string[];
  default?: string;
  healthPath?: string;
  healthMethod?: 'GET' | 'HEAD';
}

export interface ServiceCatalogEntry {
  id: string;
  name: string;
  summary: string;
  runtime: ServiceRuntime;
  kind: ServiceKind;
  domain: string;
  owner: string;
  lifecycle: ServiceLifecycle;
  enabledByDefault: boolean;
  requiredByDefault: boolean;
  enabledEnv?: string;
  requiredEnv?: string;
  dockerService?: string;
  endpoint: ServiceEndpointDefinition;
  commands: Record<string, string>;
  dependencies: string[];
  capabilities: string[];
}

export interface ServiceCatalogDocument {
  version: number;
  services: ServiceCatalogEntry[];
}

export interface ServiceEndpointResolution {
  rawEndpoint: string | null;
  endpoint: string | null;
  source: EndpointSource;
  envKey: string | null;
  healthUrl: string | null;
}

export interface ResolvedServiceCatalogEntry extends Omit<ServiceCatalogEntry, 'endpoint'> {
  enabled: boolean;
  required: boolean;
  requirement: 'required' | 'optional' | 'disabled';
  endpoint: string | null;
  endpointSource: EndpointSource;
  endpointEnvKey: string | null;
  endpointProtocol: EndpointProtocol;
  healthUrl: string | null;
  configurationStatus: ServiceConfigurationStatus;
  issues: string[];
}

export interface ServiceDependencyEdge {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  active: boolean;
}

export interface ServiceCatalogValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  serviceCount: number;
  enabledCount: number;
  requiredCount: number;
  dependencyCount: number;
}

type EnvBag = Record<string, string | undefined>;

const catalog = catalogJson as unknown as ServiceCatalogDocument;
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);

function envFlag(env: EnvBag, key: string | undefined, fallback: boolean): boolean {
  if (!key) return fallback;
  const value = env[key]?.trim().toLowerCase();
  if (!value) return fallback;
  if (FALSE_VALUES.has(value)) return false;
  if (TRUE_VALUES.has(value)) return true;
  return fallback;
}

function firstEnvValue(env: EnvBag, keys: string[]): { value: string | null; key: string | null } {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return { value, key };
  }
  return { value: null, key: null };
}

function maskEndpoint(value: string): string {
  return value
    .replace(/:\/\/([^:/?#]+):([^@/?#]+)@/, '://$1:***@')
    .replace(/([?&](?:password|token|key|secret)=)[^&]+/gi, '$1***');
}

function buildHealthUrl(rawEndpoint: string | null, endpoint: ServiceEndpointDefinition): string | null {
  if (!rawEndpoint || endpoint.protocol !== 'http' || !endpoint.healthPath) return null;
  try {
    return maskEndpoint(new URL(endpoint.healthPath, rawEndpoint).toString());
  } catch {
    return null;
  }
}

function resolveEndpoint(entry: ServiceCatalogEntry, env: EnvBag): ServiceEndpointResolution {
  const resolved = firstEnvValue(env, entry.endpoint.env);
  const rawEndpoint = resolved.value ?? entry.endpoint.default ?? null;
  const source: EndpointSource = resolved.value ? 'env' : entry.endpoint.default ? 'default' : 'missing';
  return {
    rawEndpoint,
    endpoint: rawEndpoint ? maskEndpoint(rawEndpoint) : null,
    source,
    envKey: resolved.key,
    healthUrl: buildHealthUrl(rawEndpoint, entry.endpoint),
  };
}

function serviceStatus(entry: ServiceCatalogEntry, endpoint: ServiceEndpointResolution, enabled: boolean, required: boolean) {
  const issues: string[] = [];
  if (!enabled) {
    return {
      requirement: 'disabled' as const,
      configurationStatus: 'disabled' as const,
      issues,
    };
  }
  if (!endpoint.rawEndpoint) {
    issues.push(`${entry.name} 缺少 endpoint 配置。`);
  }
  if (required && issues.length > 0) {
    return {
      requirement: 'required' as const,
      configurationStatus: 'failed' as const,
      issues,
    };
  }
  return {
    requirement: required ? 'required' as const : 'optional' as const,
    configurationStatus: issues.length > 0 ? 'warning' as const : 'ok' as const,
    issues,
  };
}

export function getServiceCatalogDocument(): ServiceCatalogDocument {
  return catalog;
}

export function getResolvedServiceCatalog(env: EnvBag = process.env): ResolvedServiceCatalogEntry[] {
  return catalog.services.map((entry) => {
    const enabled = envFlag(env, entry.enabledEnv, entry.enabledByDefault);
    const required = enabled && envFlag(env, entry.requiredEnv, entry.requiredByDefault);
    const endpoint = resolveEndpoint(entry, env);
    const status = serviceStatus(entry, endpoint, enabled, required);
    return {
      ...entry,
      enabled,
      required,
      requirement: status.requirement,
      endpoint: endpoint.endpoint,
      endpointSource: endpoint.source,
      endpointEnvKey: endpoint.envKey,
      endpointProtocol: entry.endpoint.protocol,
      healthUrl: endpoint.healthUrl,
      configurationStatus: status.configurationStatus,
      issues: status.issues,
    };
  });
}

export function getServiceRawEndpoint(serviceId: string, env: EnvBag = process.env): string | null {
  const entry = catalog.services.find((service) => service.id === serviceId);
  return entry ? resolveEndpoint(entry, env).rawEndpoint : null;
}

export function getServiceRawHealthUrl(serviceId: string, env: EnvBag = process.env): string | null {
  const entry = catalog.services.find((service) => service.id === serviceId);
  if (!entry) return null;
  const endpoint = resolveEndpoint(entry, env);
  if (!endpoint.rawEndpoint || entry.endpoint.protocol !== 'http' || !entry.endpoint.healthPath) return null;
  try {
    return new URL(entry.endpoint.healthPath, endpoint.rawEndpoint).toString();
  } catch {
    return null;
  }
}

export function buildServiceDependencyEdges(
  services: ResolvedServiceCatalogEntry[] = getResolvedServiceCatalog()
): ServiceDependencyEdge[] {
  const byId = new Map(services.map((service) => [service.id, service]));
  return services.flatMap((service) =>
    service.dependencies.map((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return {
        from: service.id,
        fromName: service.name,
        to: dependencyId,
        toName: dependency?.name ?? dependencyId,
        active: service.enabled && Boolean(dependency?.enabled),
      };
    })
  );
}

function findDependencyCycles(services: ServiceCatalogEntry[]): string[] {
  const byId = new Map(services.map((service) => [service.id, service]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[] = [];

  function walk(serviceId: string, stack: string[]) {
    if (visiting.has(serviceId)) {
      const start = stack.indexOf(serviceId);
      cycles.push([...stack.slice(start), serviceId].join(' -> '));
      return;
    }
    if (visited.has(serviceId)) return;
    const service = byId.get(serviceId);
    if (!service) return;
    visiting.add(serviceId);
    for (const dependency of service.dependencies) {
      walk(dependency, [...stack, dependency]);
    }
    visiting.delete(serviceId);
    visited.add(serviceId);
  }

  for (const service of services) {
    walk(service.id, [service.id]);
  }
  return cycles;
}

export function validateServiceCatalog(env: EnvBag = process.env): ServiceCatalogValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  const idPattern = /^[a-z][a-z0-9-]*$/;

  for (const service of catalog.services) {
    if (!idPattern.test(service.id)) {
      errors.push(`服务 id 不合法：${service.id}`);
    }
    if (ids.has(service.id)) {
      errors.push(`服务 id 重复：${service.id}`);
    }
    ids.add(service.id);
    if (!service.endpoint.env.length && !service.endpoint.default) {
      errors.push(`${service.id} 缺少 endpoint.env 或 endpoint.default。`);
    }
    if (service.endpoint.protocol === 'http' && service.endpoint.healthPath && !service.endpoint.healthPath.startsWith('/')) {
      errors.push(`${service.id} 的 healthPath 必须以 / 开头。`);
    }
    for (const envKey of [service.enabledEnv, service.requiredEnv, ...service.endpoint.env].filter(Boolean)) {
      if (!/^[A-Z0-9_]+$/.test(String(envKey))) {
        errors.push(`${service.id} 使用了不规范的环境变量名：${envKey}`);
      }
    }
    for (const dependency of service.dependencies) {
      if (!ids.has(dependency) && !catalog.services.some((item) => item.id === dependency)) {
        errors.push(`${service.id} 依赖不存在的服务：${dependency}`);
      }
    }
  }

  for (const cycle of findDependencyCycles(catalog.services)) {
    errors.push(`服务依赖存在环：${cycle}`);
  }

  const resolved = getResolvedServiceCatalog(env);
  for (const service of resolved) {
    if (service.configurationStatus === 'failed') {
      errors.push(...service.issues.map((issue) => `${service.id}: ${issue}`));
    } else if (service.configurationStatus === 'warning') {
      warnings.push(...service.issues.map((issue) => `${service.id}: ${issue}`));
    }
  }

  const edges = buildServiceDependencyEdges(resolved);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    serviceCount: resolved.length,
    enabledCount: resolved.filter((service) => service.enabled).length,
    requiredCount: resolved.filter((service) => service.required).length,
    dependencyCount: edges.length,
  };
}
