import { describe, expect, it, vi } from 'vitest';
import {
  PI_AGENT_SCHEMA_CONTRACT_VERSION,
  PI_AGENT_SCHEMA_EXPECTATIONS,
  PiAgentSchemaNotReadyError,
  assertPiAgentSchemaReady,
  evaluatePiAgentSchemaCatalog,
  type PiAgentCatalogColumn,
  type PiAgentCatalogCheckConstraint,
  type PiAgentCatalogForeignKey,
  type PiAgentCatalogIndex,
  type PiAgentSchemaCatalog,
  type PiAgentSchemaQueryClient,
} from './pi-agent-schema-readiness';

function readyCatalog(): PiAgentSchemaCatalog {
  const columns: PiAgentCatalogColumn[] = PI_AGENT_SCHEMA_EXPECTATIONS.columns.map(
    (column) => ({ ...column, defaultValue: null })
  );
  const indexes: PiAgentCatalogIndex[] = PI_AGENT_SCHEMA_EXPECTATIONS.indexes.map(
    (index, position) => ({
      tableName: index.tableName,
      indexName: `contract_index_${position}`,
      columns: [...index.columns],
      unique: index.unique ?? false,
      valid: true,
    })
  );
  const foreignKeys: PiAgentCatalogForeignKey[] =
    PI_AGENT_SCHEMA_EXPECTATIONS.foreignKeys.map((foreignKey, position) => ({
      tableName: foreignKey.tableName,
      constraintName: `contract_foreign_key_${position}`,
      columns: [...foreignKey.columns],
      referencedTableName: foreignKey.referencedTableName,
      referencedColumns: [...foreignKey.referencedColumns],
      deleteAction: foreignKey.deleteAction,
      updateAction: foreignKey.updateAction,
      validated: true,
    }));
  const checkConstraints: PiAgentCatalogCheckConstraint[] =
    PI_AGENT_SCHEMA_EXPECTATIONS.checkConstraints.map((constraint) => ({
      tableName: constraint.tableName,
      constraintName: constraint.constraintName,
      definition: `CHECK (${constraint.definitionIncludes.join(' ')})`,
      validated: true,
    }));
  return { columns, indexes, foreignKeys, checkConstraints };
}

describe('PI Agent schema readiness', () => {
  it('rejects a database that still limits jobs to post-preparation stages', () => {
    const catalog = readyCatalog();
    catalog.checkConstraints = catalog.checkConstraints.map(constraint =>
      constraint.tableName === 'agent_generation_jobs'
        ? { ...constraint, definition: "CHECK (stage IN ('agent_execution', 'automatic_validation', 'completed'))" }
        : constraint);
    expect(evaluatePiAgentSchemaCatalog(catalog)).toMatchObject({ ready: false, issues: [
      expect.objectContaining({ code: 'INVALID_CHECK_CONSTRAINT', objectName: 'public.agent_generation_jobs.agent_generation_jobs_stage_check' }),
    ] });
  });
  it('accepts the complete durable runtime and Mission Graph catalog contract', () => {
    expect(evaluatePiAgentSchemaCatalog(readyCatalog())).toEqual({
      ready: true,
      contractVersion: PI_AGENT_SCHEMA_CONTRACT_VERSION,
      issues: [],
    });
    expect(PI_AGENT_SCHEMA_CONTRACT_VERSION).toBe(
      '20260919110000_generation_preparation_stage'
    );
  });

  it('fails closed with one actionable issue when an entire runtime table is absent', () => {
    const catalog = readyCatalog();
    catalog.columns = catalog.columns.filter(
      (column) => column.tableName !== 'agent_runs'
    );

    const report = evaluatePiAgentSchemaCatalog(catalog);

    expect(report.ready).toBe(false);
    expect(report.issues).toContainEqual({
      code: 'MISSING_TABLE',
      objectName: 'public.agent_runs',
      expected: 'table',
    });
    expect(
      report.issues.some(
        (issue) =>
          issue.code === 'MISSING_COLUMN' && issue.objectName.startsWith('public.agent_runs.')
      )
    ).toBe(false);
  });

  it('reports column drift, invalid indexes, and unvalidated foreign keys', () => {
    const catalog = readyCatalog();
    catalog.columns = catalog.columns.map((column) =>
      column.tableName === 'agent_runs' && column.columnName === 'created_at'
        ? { ...column, dataType: 'timestamp with time zone', nullable: true }
        : column
    );
    catalog.indexes = catalog.indexes.map((index) =>
      index.tableName === 'agent_runs' && index.columns[0] === 'run_instance_id'
        ? { ...index, valid: false }
        : index
    );
    catalog.foreignKeys = catalog.foreignKeys.map((foreignKey) =>
      foreignKey.tableName === 'agent_runs' && foreignKey.columns.length === 2
        ? { ...foreignKey, validated: false }
        : foreignKey
    );

    const report = evaluatePiAgentSchemaCatalog(catalog);

    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'COLUMN_TYPE_MISMATCH',
        'COLUMN_NULLABILITY_MISMATCH',
        'INVALID_INDEX',
        'UNVALIDATED_FOREIGN_KEY',
      ])
    );
  });

  it.each([
    'agent_generation_leases',
    'agent_generation_jobs',
    'agent_worker_slots',
    'agent_worker_instances',
    'agent_generation_outbox_events',
    'agent_missions',
    'agent_mission_nodes',
    'agent_evidence_receipts',
  ])('fails closed when the Mission Graph table %s is absent', (tableName) => {
    const catalog = readyCatalog();
    catalog.columns = catalog.columns.filter(
      (column) => column.tableName !== tableName
    );

    const report = evaluatePiAgentSchemaCatalog(catalog);

    expect(report.ready).toBe(false);
    expect(report.issues).toContainEqual({
      code: 'MISSING_TABLE',
      objectName: `public.${tableName}`,
      expected: 'table',
    });
    expect(
      report.issues.some(
        (issue) =>
          issue.code === 'MISSING_COLUMN' &&
          issue.objectName.startsWith(`public.${tableName}.`)
      )
    ).toBe(false);
  });

  it('fails closed on Mission spec, receipt-index, and acceptance-FK drift', () => {
    const catalog = readyCatalog();
    catalog.columns = catalog.columns.filter(
      (column) =>
        !(column.tableName === 'agent_missions' && column.columnName === 'spec_hash')
    );
    catalog.indexes = catalog.indexes.map((index) =>
      index.tableName === 'agent_evidence_receipts' &&
      index.columns.length === 1 &&
      index.columns[0] === 'receipt_hash'
        ? { ...index, valid: false }
        : index
    );
    catalog.foreignKeys = catalog.foreignKeys.map((foreignKey) =>
      foreignKey.tableName === 'agent_missions' &&
      foreignKey.columns.length === 1 &&
      foreignKey.columns[0] === 'accepted_receipt_id'
        ? { ...foreignKey, validated: false }
        : foreignKey
    );

    const report = evaluatePiAgentSchemaCatalog(catalog);

    expect(report.ready).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'MISSING_COLUMN',
        objectName: 'public.agent_missions.spec_hash',
      }),
      expect.objectContaining({
        code: 'INVALID_INDEX',
        objectName: 'public.agent_evidence_receipts(receipt_hash)',
      }),
      expect.objectContaining({
        code: 'UNVALIDATED_FOREIGN_KEY',
        objectName:
          'public.agent_missions(accepted_receipt_id) -> public.agent_evidence_receipts(id)',
      }),
    ]));
  });

  it('requires the cross-worker unique active Mission slot', () => {
    const catalog = readyCatalog();
    catalog.indexes = catalog.indexes.filter(
      (index) =>
        !(index.tableName === 'agent_missions' &&
          index.columns.join(',') === 'project_id,active_slot')
    );

    const report = evaluatePiAgentSchemaCatalog(catalog);

    expect(report.issues).toContainEqual({
      code: 'MISSING_INDEX',
      objectName: 'public.agent_missions(project_id, active_slot)',
      expected: 'valid unique index',
    });
  });

  it('fails closed when AgentRun workspace identity has a default or missing SHA-256 check', () => {
    const catalog = readyCatalog();
    catalog.columns = catalog.columns.map((column) =>
      column.tableName === 'agent_runs' && column.columnName === 'workspace_key'
        ? { ...column, defaultValue: "'legacy:unknown'::text" }
        : column
    );
    catalog.checkConstraints = [];

    expect(evaluatePiAgentSchemaCatalog(catalog).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'COLUMN_DEFAULT_MISMATCH',
        objectName: 'public.agent_runs.workspace_key',
      }),
      expect.objectContaining({
        code: 'MISSING_CHECK_CONSTRAINT',
        objectName: 'public.agent_runs.agent_runs_workspace_key_sha256_check',
      }),
    ]));
  });

  it('fails closed when a Mission node ownership foreign key is missing', () => {
    const catalog = readyCatalog();
    catalog.foreignKeys = catalog.foreignKeys.filter(
      (foreignKey) =>
        !(foreignKey.tableName === 'agent_mission_nodes' &&
          foreignKey.referencedTableName === 'agent_missions')
    );

    expect(evaluatePiAgentSchemaCatalog(catalog).issues).toContainEqual({
      code: 'MISSING_FOREIGN_KEY',
      objectName:
        'public.agent_mission_nodes(mission_id) -> public.agent_missions(id)',
      expected: 'ON DELETE CASCADE ON UPDATE CASCADE',
    });
  });

  it('uses only catalog reads and throws a stable deployment error for an empty schema', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const client = { $queryRawUnsafe: query } as unknown as PiAgentSchemaQueryClient;

    await expect(assertPiAgentSchemaReady(client)).rejects.toMatchObject({
      name: 'PiAgentSchemaNotReadyError',
      code: 'PI_AGENT_SCHEMA_NOT_READY',
      contractVersion: PI_AGENT_SCHEMA_CONTRACT_VERSION,
    });
    expect(query).toHaveBeenCalledTimes(4);
    for (const [sql] of query.mock.calls.slice(0, 3)) {
      expect(sql).toMatch(/^\s*SELECT/);
      expect(sql).not.toMatch(/\b(?:ALTER|CREATE|DELETE|DROP|INSERT|TRUNCATE|UPDATE)\b/i);
      expect(sql).toContain("'agent_missions'");
      expect(sql).toContain("'agent_mission_nodes'");
      expect(sql).toContain("'agent_evidence_receipts'");
      expect(sql).toContain("'agent_generation_leases'");
      expect(sql).toContain("'agent_generation_jobs'");
      expect(sql).toContain("'agent_worker_slots'");
      expect(sql).toContain("'agent_worker_instances'");
      expect(sql).toContain("'agent_generation_outbox_events'");
    }
    expect(query.mock.calls[3][0]).toContain("'agent_runs'");

    try {
      await assertPiAgentSchemaReady({
        $queryRawUnsafe: async <T = unknown>() => [] as T,
      });
      throw new Error('Expected readiness assertion to throw.');
    } catch (error) {
      expect(error).toBeInstanceOf(PiAgentSchemaNotReadyError);
      expect((error as PiAgentSchemaNotReadyError).issues).toHaveLength(
        new Set(
          PI_AGENT_SCHEMA_EXPECTATIONS.columns.map((column) => column.tableName),
        ).size,
      );
    }
  });
});
