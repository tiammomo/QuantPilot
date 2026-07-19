import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { recordContextAcceptance, recordContextExposure } from './use-manifest';
import { createProjectIntegrationScope } from './integration-scope';

const temporaryDirectories: string[] = [];

function scope(projectId = 'project-a') {
  return createProjectIntegrationScope({
    projectId,
    memory: { tenantId: 'tenant-quantpilot' },
    knowledge: {
      spaces: ['https://knowledge.example/spaces/shared'],
      projectSpacesEnabled: true,
      projectSpaceBaseUrl: 'https://knowledge.example/spaces/projects',
    },
  });
}

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-context-use-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe('context use manifest', () => {
  it('joins opaque Memory and Knowledge receipts without persisting context content', async () => {
    const projectPath = await workspace();
    const integrationScope = scope();
    await recordContextExposure({
      projectPath,
      projectId: 'project-a',
      requestId: 'request-a',
      integrationScope,
      memory: {
        content: 'private preference content',
        usageId: 'memory-usage-a',
        traceId: 'memory-trace-a',
        revisionIds: ['memory-revision-a'],
        sourceProjectionSha256: 'a'.repeat(64),
        contentSha256: 'b'.repeat(64),
      },
      knowledge: {
        content: 'governed knowledge content',
        contextPackId: 'context-pack-a',
        contextDigest: 'context-digest-a',
        exposureReceiptId: 'exposure-a',
        policyEpoch: 'policy-a',
        purpose: 'quant-research',
        citations: [{
          citationId: 'citation-a',
          chunkId: 'chunk-a',
          payloadDigest: 'payload-a',
          locator: {},
          quote: 'do not persist this quote',
          recordId: 'record-a',
          revisionId: 'knowledge-revision-a',
          spaceId: 'space-a',
        }],
        obligations: [],
        qualityDecision: 'suitable',
        warningCodes: [],
        integrationScopeSha256: integrationScope.scopeSha256,
        consumerId: integrationScope.consumerId,
        requestedSpaceIds: integrationScope.knowledge.requestedSpaceIds,
        projectSpaceId: integrationScope.knowledge.projectSpaceId,
      },
    });
    await recordContextAcceptance({
      projectPath,
      projectId: 'project-a',
      requestId: 'request-a',
      integrationScope,
      knowledgeUsage: {
        status: 'recorded',
        usageReceipts: [{
          usageId: 'knowledge-usage-a',
          exposureReceiptId: 'exposure-a',
          spaceId: 'space-a',
          policyEpoch: 'policy-a',
          createdAt: '2026-07-19T00:00:00Z',
          feedbackUntil: '2026-08-19T00:00:00Z',
        }],
      },
      mission: {
        missionId: 'mission-a',
        acceptedReceiptId: 'acceptance-a',
        acceptedReceiptSha256: 'c'.repeat(64),
      },
    });

    const raw = await fs.readFile(
      path.join(projectPath, 'evidence', 'context-uses', 'request-a.json'),
      'utf8',
    );
    expect(raw).not.toContain('private preference content');
    expect(raw).not.toContain('governed knowledge content');
    expect(raw).not.toContain('do not persist this quote');
    expect(JSON.parse(raw)).toMatchObject({
      memory: { usageId: 'memory-usage-a', revisionIds: ['memory-revision-a'] },
      knowledge: {
        contextPackId: 'context-pack-a',
        usage: { status: 'recorded' },
      },
      acceptedMission: { missionId: 'mission-a' },
      integrationScope: {
        scopeSha256: integrationScope.scopeSha256,
        projectId: 'project-a',
      },
    });
  });

  it('rejects a different exposure replay for the same request', async () => {
    const projectPath = await workspace();
    const base = {
      projectPath,
      projectId: 'project-a',
      requestId: 'request-a',
      integrationScope: scope(),
      knowledge: null,
    };
    await recordContextExposure({
      ...base,
      memory: {
        content: 'first',
        usageId: 'memory-usage-a',
        traceId: 'memory-trace-a',
        revisionIds: ['memory-revision-a'],
        sourceProjectionSha256: 'a'.repeat(64),
        contentSha256: 'b'.repeat(64),
      },
    });

    await expect(recordContextExposure({
      ...base,
      memory: {
        content: 'second',
        usageId: 'memory-usage-b',
        traceId: 'memory-trace-b',
        revisionIds: ['memory-revision-b'],
        sourceProjectionSha256: 'c'.repeat(64),
        contentSha256: 'd'.repeat(64),
      },
    })).rejects.toThrow('idempotency collision');
  });

  it('rejects acceptance when the trusted project integration scope changed', async () => {
    const projectPath = await workspace();
    await recordContextExposure({
      projectPath,
      projectId: 'project-a',
      requestId: 'request-a',
      integrationScope: scope(),
      memory: null,
      knowledge: {
        content: 'governed context',
        contextPackId: 'context-pack-a',
        contextDigest: 'context-digest-a',
        exposureReceiptId: 'exposure-a',
        policyEpoch: 'policy-a',
        purpose: 'quant-research',
        citations: [],
        obligations: [],
        qualityDecision: 'suitable',
        warningCodes: [],
        integrationScopeSha256: scope().scopeSha256,
        consumerId: scope().consumerId,
        requestedSpaceIds: scope().knowledge.requestedSpaceIds,
        projectSpaceId: scope().knowledge.projectSpaceId,
      },
    });

    const changedScope = createProjectIntegrationScope({
      projectId: 'project-a',
      memory: { tenantId: 'tenant-quantpilot' },
      knowledge: {
        spaces: ['https://knowledge.example/spaces/different-shared-space'],
        projectSpacesEnabled: true,
        projectSpaceBaseUrl: 'https://knowledge.example/spaces/projects',
      },
    });
    await expect(recordContextAcceptance({
      projectPath,
      projectId: 'project-a',
      requestId: 'request-a',
      integrationScope: changedScope,
      knowledgeUsage: null,
      mission: {
        missionId: 'mission-a',
        acceptedReceiptId: 'acceptance-a',
        acceptedReceiptSha256: 'c'.repeat(64),
      },
    })).rejects.toThrow('scope or schema does not match');
  });
});
