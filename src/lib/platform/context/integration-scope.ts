import { createHash } from 'node:crypto';

import {
  getKnowledgeIntegrationConfig,
  type KnowledgeIntegrationConfig,
} from '@/lib/platform/knowledge/config';
import {
  getMemoryIntegrationConfig,
  type MemoryIntegrationConfig,
} from '@/lib/platform/memory/config';

const SCHEMA_VERSION = 1 as const;
const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type Environment = Readonly<Record<string, string | undefined>>;

export interface ProjectIntegrationScope {
  schemaVersion: typeof SCHEMA_VERSION;
  consumerId: string;
  projectId: string;
  modelPort: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  };
  memory: {
    tenantId: string;
    context: {
      product: 'quantpilot';
      project_id: string;
    };
  };
  knowledge: {
    sharedSpaceIds: string[];
    projectSpaceId: string | null;
    requestedSpaceIds: string[];
  };
  scopeSha256: string;
}

function scopeId(value: string | undefined, fallback: string, label: string): string {
  const normalized = value?.trim() || fallback;
  if (!SCOPE_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} must contain 1-128 safe scope characters.`);
  }
  return normalized;
}

function projectId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error('Project integration scope project ID is invalid.');
  }
  return normalized;
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function projectSpaceId(baseUrl: string, value: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(encodeURIComponent(value), base).toString();
}

function digest(value: Omit<ProjectIntegrationScope, 'scopeSha256'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

/**
 * Creates the immutable, server-owned scope propagated to every external
 * platform. `projectId` must come from the authorized route/database object,
 * never from an arbitrary request-body scope claim.
 */
export function createProjectIntegrationScope(input: {
  projectId: string;
  memory: Pick<MemoryIntegrationConfig, 'tenantId'>;
  knowledge: Pick<
    KnowledgeIntegrationConfig,
    'spaces' | 'projectSpacesEnabled' | 'projectSpaceBaseUrl'
  >;
  environment?: Environment;
}): ProjectIntegrationScope {
  const environment = input.environment ?? process.env;
  const trustedProjectId = projectId(input.projectId);
  const consumerId = scopeId(
    environment.QUANTPILOT_INTEGRATION_CONSUMER_ID,
    'quantpilot',
    'QUANTPILOT_INTEGRATION_CONSUMER_ID',
  );
  const tenantId = scopeId(input.memory.tenantId, 'quantpilot-local', 'Memory tenant ID');
  const projectKnowledgeSpace = input.knowledge.projectSpacesEnabled
    ? projectSpaceId(input.knowledge.projectSpaceBaseUrl, trustedProjectId)
    : null;
  const sharedSpaceIds = stableUnique(input.knowledge.spaces);
  const requestedSpaceIds = stableUnique([
    ...sharedSpaceIds,
    ...(projectKnowledgeSpace ? [projectKnowledgeSpace] : []),
  ]);
  const unsigned = {
    schemaVersion: SCHEMA_VERSION,
    consumerId,
    projectId: trustedProjectId,
    modelPort: {
      organizationId: scopeId(
        environment.QUANTPILOT_MODELPORT_ORGANIZATION_ID,
        'org_local',
        'QUANTPILOT_MODELPORT_ORGANIZATION_ID',
      ),
      projectId: scopeId(
        environment.QUANTPILOT_MODELPORT_PROJECT_ID,
        'prj_quantpilot',
        'QUANTPILOT_MODELPORT_PROJECT_ID',
      ),
      environmentId: scopeId(
        environment.QUANTPILOT_MODELPORT_ENVIRONMENT_ID,
        environment.NODE_ENV === 'production' ? 'env_production' : 'env_development',
        'QUANTPILOT_MODELPORT_ENVIRONMENT_ID',
      ),
    },
    memory: {
      tenantId,
      context: { product: 'quantpilot' as const, project_id: trustedProjectId },
    },
    knowledge: { sharedSpaceIds, projectSpaceId: projectKnowledgeSpace, requestedSpaceIds },
  };
  return { ...unsigned, scopeSha256: digest(unsigned) };
}

export function modelPortScopeHeaders(
  scope: Pick<ProjectIntegrationScope, 'modelPort'>,
): Readonly<Record<string, string>> {
  return {
    'X-ModelPort-Organization-Id': scope.modelPort.organizationId,
    'X-ModelPort-Project-Id': scope.modelPort.projectId,
    'X-ModelPort-Environment-Id': scope.modelPort.environmentId,
  };
}

export function getProjectIntegrationScope(
  trustedProjectId: string,
  environment: Environment = process.env,
): ProjectIntegrationScope {
  return createProjectIntegrationScope({
    projectId: trustedProjectId,
    memory: getMemoryIntegrationConfig(environment),
    knowledge: getKnowledgeIntegrationConfig(environment),
    environment,
  });
}
