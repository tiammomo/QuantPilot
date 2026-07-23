import { describe, expect, it, vi } from 'vitest';
import {
  MOAGENT_SCHEMA_CONTRACT_VERSION,
  MOAGENT_SCHEMA_EXPECTATIONS,
  MoAgentSchemaNotReadyError,
  assertMoAgentSchemaReady,
  evaluateMoAgentSchemaCatalog,
  type MoAgentCatalogColumn,
  type MoAgentCatalogCheckConstraint,
  type MoAgentCatalogForeignKey,
  type MoAgentCatalogIndex,
  type MoAgentSchemaCatalog,
  type MoAgentSchemaQueryClient,
} from './moagent-schema-readiness';

function readyCatalog(): MoAgentSchemaCatalog {
  const columns: MoAgentCatalogColumn[] = MOAGENT_SCHEMA_EXPECTATIONS.columns.map(
    (column) => ({ ...column, defaultValue: null })
  );
  const indexes: MoAgentCatalogIndex[] = MOAGENT_SCHEMA_EXPECTATIONS.indexes.map(
    (index, position) => ({
      tableName: index.tableName,
      indexName: `contract_index_${position}`,
      columns: [...index.columns],
      unique: index.unique ?? false,
      valid: true,
    })
  );
  const foreignKeys: MoAgentCatalogForeignKey[] =
    MOAGENT_SCHEMA_EXPECTATIONS.foreignKeys.map((foreignKey, position) => ({
      tableName: foreignKey.tableName,
      constraintName: `contract_foreign_key_${position}`,
      columns: [...foreignKey.columns],
      referencedTableName: foreignKey.referencedTableName,
      referencedColumns: [...foreignKey.referencedColumns],
      deleteAction: foreignKey.deleteAction,
      updateAction: foreignKey.updateAction,
      validated: true,
    }));
  const checkConstraints: MoAgentCatalogCheckConstraint[] =
    MOAGENT_SCHEMA_EXPECTATIONS.checkConstraints.map((constraint) => ({
      tableName: constraint.tableName,
      constraintName: constraint.constraintName,
      definition: `CHECK ((workspace_key ~ '${constraint.definitionIncludes[1]}'::text))`,
      validated: true,
    }));
  return { columns, indexes, foreignKeys, checkConstraints };
}

describe('MoAgent schema readiness', () => {
  it('accepts the complete durable runtime and Mission Graph catalog contract', () => {
    expect(evaluateMoAgentSchemaCatalog(readyCatalog())).toEqual({
      ready: true,
      contractVersion: MOAGENT_SCHEMA_CONTRACT_VERSION,
      issues: [],
    });
    expect(MOAGENT_SCHEMA_CONTRACT_VERSION).toBe(
      '20260723000400_worker_registry_and_observability'
    );
  });

  it('fails closed with one actionable issue when an entire runtime table is absent', () => {
    const catalog = readyCatalog();
    catalog.columns = catalog.columns.filter(
      (column) => column.tableName !== 'agent_runs'
    );

    const report = evaluateMoAgentSchemaCatalog(catalog);

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

    const report = evaluateMoAgentSchemaCatalog(catalog);

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

    const report = evaluateMoAgentSchemaCatalog(catalog);

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

    const report = evaluateMoAgentSchemaCatalog(catalog);

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

    const report = evaluateMoAgentSchemaCatalog(catalog);

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

    expect(evaluateMoAgentSchemaCatalog(catalog).issues).toEqual(expect.arrayContaining([
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

    expect(evaluateMoAgentSchemaCatalog(catalog).issues).toContainEqual({
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
    const client = { $queryRawUnsafe: query } as unknown as MoAgentSchemaQueryClient;

    await expect(assertMoAgentSchemaReady(client)).rejects.toMatchObject({
      name: 'MoAgentSchemaNotReadyError',
      code: 'MOAGENT_SCHEMA_NOT_READY',
      contractVersion: MOAGENT_SCHEMA_CONTRACT_VERSION,
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
      await assertMoAgentSchemaReady({
        $queryRawUnsafe: async <T = unknown>() => [] as T,
      });
      throw new Error('Expected readiness assertion to throw.');
    } catch (error) {
      expect(error).toBeInstanceOf(MoAgentSchemaNotReadyError);
      expect((error as MoAgentSchemaNotReadyError).issues).toHaveLength(
        new Set(
          MOAGENT_SCHEMA_EXPECTATIONS.columns.map((column) => column.tableName),
        ).size,
      );
    }
  });
});
