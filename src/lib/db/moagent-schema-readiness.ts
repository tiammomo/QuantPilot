/**
 * Read-only PostgreSQL catalog checks for the durable MoAgent runtime schema.
 *
 * This deliberately does not attempt to repair schema drift. Production
 * deployments must apply the checked-in Prisma migrations before accepting a
 * run; mutating the database from a request path would make partial upgrades
 * and split-brain application versions much harder to reason about.
 */

export const MOAGENT_SCHEMA_CONTRACT_VERSION =
  '20260719000600_add_generation_dispatch_outbox' as const;

export interface MoAgentSchemaQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): PromiseLike<T>;
}

export interface MoAgentCatalogColumn {
  tableName: string;
  columnName: string;
  dataType: string;
  nullable: boolean;
}

export interface MoAgentCatalogIndex {
  tableName: string;
  indexName: string;
  columns: string[];
  unique: boolean;
  valid: boolean;
}

export interface MoAgentCatalogForeignKey {
  tableName: string;
  constraintName: string;
  columns: string[];
  referencedTableName: string;
  referencedColumns: string[];
  deleteAction: string;
  updateAction: string;
  validated: boolean;
}

export interface MoAgentSchemaCatalog {
  columns: readonly MoAgentCatalogColumn[];
  indexes: readonly MoAgentCatalogIndex[];
  foreignKeys: readonly MoAgentCatalogForeignKey[];
}

export type MoAgentSchemaIssueCode =
  | 'MISSING_TABLE'
  | 'MISSING_COLUMN'
  | 'COLUMN_TYPE_MISMATCH'
  | 'COLUMN_NULLABILITY_MISMATCH'
  | 'MISSING_INDEX'
  | 'INVALID_INDEX'
  | 'MISSING_FOREIGN_KEY'
  | 'UNVALIDATED_FOREIGN_KEY';

export interface MoAgentSchemaIssue {
  code: MoAgentSchemaIssueCode;
  objectName: string;
  expected: string;
  actual?: string;
}

export interface MoAgentSchemaReadinessReport {
  ready: boolean;
  contractVersion: typeof MOAGENT_SCHEMA_CONTRACT_VERSION;
  issues: MoAgentSchemaIssue[];
}

interface ExpectedColumn {
  tableName: string;
  columnName: string;
  dataType: string;
  nullable: boolean;
}

interface ExpectedIndex {
  tableName: string;
  columns: readonly string[];
  unique?: boolean;
}

interface ExpectedForeignKey {
  tableName: string;
  columns: readonly string[];
  referencedTableName: string;
  referencedColumns: readonly string[];
  deleteAction: string;
  updateAction: string;
}

type ColumnDefinition = readonly [dataType: string, nullable: boolean];

const EXPECTED_COLUMN_DEFINITIONS = {
  projects: {
    id: ['text', false],
  },
  user_requests: {
    id: ['text', false],
    project_id: ['text', false],
  },
  agent_runs: {
    id: ['text', false],
    run_instance_id: ['uuid', false],
    project_id: ['text', false],
    request_id: ['text', true],
    workspace_key: ['text', false],
    status: ['text', false],
    lease_owner: ['text', true],
    lease_expires_at: ['timestamp without time zone', true],
    last_heartbeat_at: ['timestamp without time zone', true],
    fencing_token: ['integer', false],
    workspace_fencing_token: ['integer', false],
    provider: ['text', false],
    model: ['text', false],
    framework_version: ['text', false],
    build_revision: ['text', false],
    profile_hash: ['text', false],
    prompt_hash: ['text', false],
    tool_hash: ['text', false],
    skill_hash: ['text', false],
    workspace_hash: ['text', false],
    turn_count: ['integer', false],
    input_tokens: ['integer', false],
    output_tokens: ['integer', false],
    total_tokens: ['integer', false],
    cached_input_tokens: ['integer', false],
    cache_miss_input_tokens: ['integer', false],
    reasoning_tokens: ['integer', false],
    version: ['integer', false],
    last_event_sequence: ['integer', false],
    latest_checkpoint_sequence: ['integer', true],
    error_code: ['text', true],
    error_message: ['text', true],
    started_at: ['timestamp without time zone', true],
    finished_at: ['timestamp without time zone', true],
    created_at: ['timestamp without time zone', false],
    updated_at: ['timestamp without time zone', false],
  },
  agent_workspace_leases: {
    project_id: ['text', false],
    workspace_key: ['text', false],
    status: ['text', false],
    active_run_id: ['text', true],
    lease_owner: ['text', true],
    lease_expires_at: ['timestamp without time zone', true],
    last_heartbeat_at: ['timestamp without time zone', true],
    fencing_token: ['integer', false],
    version: ['integer', false],
    acquired_at: ['timestamp without time zone', true],
    released_at: ['timestamp without time zone', true],
    created_at: ['timestamp without time zone', false],
    updated_at: ['timestamp without time zone', false],
  },
  agent_generation_leases: {
    project_id: ['text', false],
    active_request_id: ['text', true],
    operation_id: ['text', true],
    stage: ['text', true],
    status: ['text', false],
    lease_owner: ['text', true],
    lease_expires_at: ['timestamp without time zone', true],
    last_heartbeat_at: ['timestamp without time zone', true],
    fencing_token: ['integer', false],
    version: ['integer', false],
    acquired_at: ['timestamp without time zone', true],
    released_at: ['timestamp without time zone', true],
    created_at: ['timestamp without time zone', false],
    updated_at: ['timestamp without time zone', false],
  },
  agent_generation_jobs: {
    id: ['uuid', false],
    project_id: ['text', false],
    request_id: ['text', false],
    status: ['text', false],
    stage: ['text', false],
    execution_envelope: ['jsonb', false],
    instruction_hash: ['text', false],
    instruction_preview: ['text', false],
    cli_preference: ['text', true],
    selected_model: ['text', true],
    attempt_count: ['integer', false],
    max_attempts: ['integer', false],
    available_at: ['timestamp without time zone', false],
    lease_owner: ['text', true],
    lease_expires_at: ['timestamp without time zone', true],
    last_heartbeat_at: ['timestamp without time zone', true],
    fencing_token: ['integer', false],
    version: ['integer', false],
    event_sequence: ['integer', false],
    error_code: ['text', true],
    error_message: ['text', true],
    queued_at: ['timestamp without time zone', false],
    started_at: ['timestamp without time zone', true],
    completed_at: ['timestamp without time zone', true],
    created_at: ['timestamp without time zone', false],
    updated_at: ['timestamp without time zone', false],
  },
  agent_generation_outbox_events: {
    id: ['uuid', false],
    job_id: ['uuid', false],
    project_id: ['text', false],
    request_id: ['text', false],
    sequence: ['integer', false],
    event_type: ['text', false],
    payload: ['jsonb', false],
    occurred_at: ['timestamp without time zone', false],
    published_at: ['timestamp without time zone', true],
    created_at: ['timestamp without time zone', false],
  },
  agent_events: {
    id: ['text', false],
    event_id: ['text', false],
    run_id: ['text', false],
    sequence: ['integer', false],
    event_type: ['text', false],
    payload: ['jsonb', false],
    occurred_at: ['timestamp without time zone', false],
    created_at: ['timestamp without time zone', false],
  },
  agent_checkpoints: {
    id: ['text', false],
    run_id: ['text', false],
    sequence: ['integer', false],
    turn: ['integer', false],
    boundary: ['text', false],
    recovery_mode: ['text', false],
    public_state: ['jsonb', false],
    opaque_state: ['text', true],
    opaque_codec: ['text', true],
    state_hash: ['text', false],
    state_version: ['integer', false],
    fencing_token: ['integer', false],
    created_at: ['timestamp without time zone', false],
  },
  agent_tool_executions: {
    id: ['text', false],
    run_id: ['text', false],
    operation_id: ['text', false],
    tool_call_id: ['text', false],
    tool_name: ['text', false],
    input_hash: ['text', false],
    effect: ['text', false],
    idempotency: ['text', false],
    idempotency_key: ['text', true],
    status: ['text', false],
    result_receipt: ['jsonb', true],
    pre_state_hash: ['text', true],
    post_state_hash: ['text', true],
    error_code: ['text', true],
    error_message: ['text', true],
    fencing_token: ['integer', false],
    workspace_fencing_token: ['integer', false],
    prepared_at: ['timestamp without time zone', false],
    completed_at: ['timestamp without time zone', true],
    updated_at: ['timestamp without time zone', false],
  },
  agent_missions: {
    id: ['text', false],
    generation_id: ['uuid', false],
    project_id: ['text', false],
    request_id: ['text', false],
    status: ['text', false],
    active_slot: ['integer', true],
    version: ['integer', false],
    candidate_version: ['integer', false],
    current_candidate_run_id: ['text', true],
    current_candidate_request_id: ['text', true],
    accepted_receipt_id: ['text', true],
    verification_lease_owner: ['text', true],
    verification_lease_expires_at: ['timestamp without time zone', true],
    verification_last_heartbeat_at: ['timestamp without time zone', true],
    verification_fencing_token: ['integer', false],
    spec: ['jsonb', false],
    spec_hash: ['text', false],
    error_code: ['text', true],
    error_message: ['text', true],
    candidate_submitted_at: ['timestamp without time zone', true],
    verification_started_at: ['timestamp without time zone', true],
    completed_at: ['timestamp without time zone', true],
    created_at: ['timestamp without time zone', false],
    updated_at: ['timestamp without time zone', false],
  },
  agent_mission_nodes: {
    id: ['text', false],
    mission_id: ['text', false],
    node_key: ['text', false],
    node_type: ['text', false],
    effect: ['text', false],
    status: ['text', false],
    version: ['integer', false],
    dependencies: ['jsonb', false],
    allowed_tools: ['jsonb', false],
    required_skill_sections: ['jsonb', false],
    input_artifacts: ['jsonb', false],
    output_artifacts: ['jsonb', false],
    budget: ['jsonb', false],
    acceptance_predicates: ['jsonb', false],
    started_at: ['timestamp without time zone', true],
    finished_at: ['timestamp without time zone', true],
    created_at: ['timestamp without time zone', false],
    updated_at: ['timestamp without time zone', false],
  },
  agent_evidence_receipts: {
    id: ['text', false],
    mission_id: ['text', false],
    candidate_version: ['integer', false],
    receipt_type: ['text', false],
    verdict: ['text', false],
    subject_hash: ['text', false],
    receipt_hash: ['text', false],
    source_run_id: ['text', true],
    source_request_id: ['text', true],
    payload: ['jsonb', false],
    created_at: ['timestamp without time zone', false],
  },
} as const satisfies Record<string, Record<string, ColumnDefinition>>;

const EXPECTED_COLUMNS: ExpectedColumn[] = Object.entries(
  EXPECTED_COLUMN_DEFINITIONS
).flatMap(([tableName, definitions]) =>
  Object.entries(definitions).map(([columnName, [dataType, nullable]]) => ({
    tableName,
    columnName,
    dataType,
    nullable,
  }))
);

const EXPECTED_INDEXES: readonly ExpectedIndex[] = [
  { tableName: 'user_requests', columns: ['id', 'project_id'], unique: true },
  { tableName: 'agent_runs', columns: ['id'], unique: true },
  { tableName: 'agent_runs', columns: ['run_instance_id'], unique: true },
  { tableName: 'agent_runs', columns: ['project_id', 'created_at'] },
  { tableName: 'agent_runs', columns: ['request_id', 'created_at'] },
  { tableName: 'agent_runs', columns: ['status', 'lease_expires_at'] },
  { tableName: 'agent_workspace_leases', columns: ['project_id'], unique: true },
  { tableName: 'agent_workspace_leases', columns: ['workspace_key'], unique: true },
  { tableName: 'agent_workspace_leases', columns: ['active_run_id'], unique: true },
  { tableName: 'agent_workspace_leases', columns: ['status', 'lease_expires_at'] },
  { tableName: 'agent_generation_leases', columns: ['project_id'], unique: true },
  { tableName: 'agent_generation_leases', columns: ['status', 'lease_expires_at'] },
  { tableName: 'agent_generation_leases', columns: ['active_request_id'] },
  { tableName: 'agent_generation_jobs', columns: ['id'], unique: true },
  {
    tableName: 'agent_generation_jobs',
    columns: ['request_id', 'project_id'],
    unique: true,
  },
  { tableName: 'agent_generation_jobs', columns: ['project_id', 'queued_at'] },
  { tableName: 'agent_generation_jobs', columns: ['status', 'available_at'] },
  { tableName: 'agent_generation_jobs', columns: ['status', 'lease_expires_at'] },
  { tableName: 'agent_generation_jobs', columns: ['project_id'], unique: true },
  {
    tableName: 'agent_generation_outbox_events',
    columns: ['id'],
    unique: true,
  },
  {
    tableName: 'agent_generation_outbox_events',
    columns: ['job_id', 'sequence'],
    unique: true,
  },
  {
    tableName: 'agent_generation_outbox_events',
    columns: ['project_id', 'created_at'],
  },
  {
    tableName: 'agent_generation_outbox_events',
    columns: ['published_at', 'created_at'],
  },
  { tableName: 'agent_events', columns: ['event_id'], unique: true },
  { tableName: 'agent_events', columns: ['run_id', 'sequence'], unique: true },
  { tableName: 'agent_events', columns: ['run_id', 'created_at'] },
  { tableName: 'agent_checkpoints', columns: ['run_id', 'sequence'], unique: true },
  { tableName: 'agent_checkpoints', columns: ['run_id', 'created_at'] },
  { tableName: 'agent_tool_executions', columns: ['operation_id'], unique: true },
  { tableName: 'agent_tool_executions', columns: ['run_id', 'status'] },
  { tableName: 'agent_tool_executions', columns: ['status', 'updated_at'] },
  { tableName: 'agent_missions', columns: ['id'], unique: true },
  { tableName: 'agent_missions', columns: ['generation_id'], unique: true },
  { tableName: 'agent_missions', columns: ['request_id'], unique: true },
  { tableName: 'agent_missions', columns: ['accepted_receipt_id'], unique: true },
  {
    tableName: 'agent_missions',
    columns: ['request_id', 'project_id'],
    unique: true,
  },
  {
    tableName: 'agent_missions',
    columns: ['project_id', 'active_slot'],
    unique: true,
  },
  {
    tableName: 'agent_missions',
    columns: ['project_id', 'status', 'updated_at'],
    unique: false,
  },
  { tableName: 'agent_missions', columns: ['status', 'updated_at'], unique: false },
  {
    tableName: 'agent_missions',
    columns: ['status', 'verification_lease_expires_at'],
    unique: false,
  },
  { tableName: 'agent_mission_nodes', columns: ['id'], unique: true },
  {
    tableName: 'agent_mission_nodes',
    columns: ['mission_id', 'node_key'],
    unique: true,
  },
  {
    tableName: 'agent_mission_nodes',
    columns: ['mission_id', 'status'],
    unique: false,
  },
  { tableName: 'agent_evidence_receipts', columns: ['id'], unique: true },
  {
    tableName: 'agent_evidence_receipts',
    columns: ['receipt_hash'],
    unique: true,
  },
  {
    tableName: 'agent_evidence_receipts',
    columns: ['mission_id', 'candidate_version', 'receipt_type', 'subject_hash'],
    unique: true,
  },
  {
    tableName: 'agent_evidence_receipts',
    columns: ['mission_id', 'candidate_version', 'created_at'],
    unique: false,
  },
  {
    tableName: 'agent_evidence_receipts',
    columns: ['verdict', 'created_at'],
    unique: false,
  },
] as const;

const EXPECTED_FOREIGN_KEYS: readonly ExpectedForeignKey[] = [
  {
    tableName: 'agent_runs',
    columns: ['project_id'],
    referencedTableName: 'projects',
    referencedColumns: ['id'],
    deleteAction: 'CASCADE',
    updateAction: 'CASCADE',
  },
  {
    tableName: 'agent_runs',
    columns: ['request_id', 'project_id'],
    referencedTableName: 'user_requests',
    referencedColumns: ['id', 'project_id'],
    deleteAction: 'RESTRICT',
    updateAction: 'CASCADE',
  },
  {
    tableName: 'agent_workspace_leases',
    columns: ['project_id'],
    referencedTableName: 'projects',
    referencedColumns: ['id'],
    deleteAction: 'CASCADE',
    updateAction: 'CASCADE',
  },
  {
    tableName: 'agent_generation_leases',
    columns: ['project_id'],
    referencedTableName: 'projects',
    referencedColumns: ['id'],
    deleteAction: 'CASCADE',
    updateAction: 'CASCADE',
  },
  {
    tableName: 'agent_generation_jobs',
    columns: ['project_id'],
    referencedTableName: 'projects',
    referencedColumns: ['id'],
    deleteAction: 'CASCADE',
    updateAction: 'CASCADE',
  },
  {
    tableName: 'agent_generation_jobs',
    columns: ['request_id', 'project_id'],
    referencedTableName: 'user_requests',
    referencedColumns: ['id', 'project_id'],
    deleteAction: 'RESTRICT',
    updateAction: 'CASCADE',
  },
  {
    tableName: 'agent_generation_outbox_events',
    columns: ['job_id'],
    referencedTableName: 'agent_generation_jobs',
    referencedColumns: ['id'],
    deleteAction: 'CASCADE',
    updateAction: 'CASCADE',
  },
  {
    tableName: 'agent_generation_leases',
    columns: ['active_request_id', 'project_id'],
    referencedTableName: 'user_requests',
    referencedColumns: ['id', 'project_id'],
    deleteAction: 'RESTRICT',
    updateAction: 'CASCADE',
  },
  ...['agent_events', 'agent_checkpoints', 'agent_tool_executions'].map(
    (tableName): ExpectedForeignKey => ({
      tableName,
      columns: ['run_id'],
      referencedTableName: 'agent_runs',
      referencedColumns: ['id'],
      deleteAction: 'CASCADE',
      updateAction: 'CASCADE',
    })
  ),
  {
    tableName: 'agent_missions',
    columns: ['project_id'],
    referencedTableName: 'projects',
    referencedColumns: ['id'],
    deleteAction: 'CASCADE',
    updateAction: 'CASCADE',
  },
  {
    tableName: 'agent_missions',
    columns: ['request_id', 'project_id'],
    referencedTableName: 'user_requests',
    referencedColumns: ['id', 'project_id'],
    deleteAction: 'RESTRICT',
    updateAction: 'CASCADE',
  },
  {
    tableName: 'agent_mission_nodes',
    columns: ['mission_id'],
    referencedTableName: 'agent_missions',
    referencedColumns: ['id'],
    deleteAction: 'CASCADE',
    updateAction: 'CASCADE',
  },
  {
    tableName: 'agent_evidence_receipts',
    columns: ['mission_id'],
    referencedTableName: 'agent_missions',
    referencedColumns: ['id'],
    deleteAction: 'CASCADE',
    updateAction: 'CASCADE',
  },
  {
    tableName: 'agent_missions',
    columns: ['accepted_receipt_id'],
    referencedTableName: 'agent_evidence_receipts',
    referencedColumns: ['id'],
    deleteAction: 'SET NULL',
    updateAction: 'CASCADE',
  },
];

/** Exposed for deterministic contract tests and operator-facing diagnostics. */
export const MOAGENT_SCHEMA_EXPECTATIONS = {
  columns: EXPECTED_COLUMNS,
  indexes: EXPECTED_INDEXES,
  foreignKeys: EXPECTED_FOREIGN_KEYS,
} as const;

const CATALOG_COLUMNS_SQL = `
SELECT
  table_name AS "tableName",
  column_name AS "columnName",
  data_type AS "dataType",
  (is_nullable = 'YES') AS "nullable"
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'projects',
    'user_requests',
    'agent_runs',
    'agent_workspace_leases',
    'agent_generation_leases',
    'agent_generation_jobs',
    'agent_generation_outbox_events',
    'agent_events',
    'agent_checkpoints',
    'agent_tool_executions',
    'agent_missions',
    'agent_mission_nodes',
    'agent_evidence_receipts'
  )
ORDER BY table_name, ordinal_position
`;

const CATALOG_INDEXES_SQL = `
SELECT
  table_class.relname AS "tableName",
  index_class.relname AS "indexName",
  array_agg(column_info.attname ORDER BY key_column.ordinality) AS "columns",
  index_info.indisunique AS "unique",
  index_info.indisvalid AS "valid"
FROM pg_catalog.pg_index AS index_info
JOIN pg_catalog.pg_class AS table_class
  ON table_class.oid = index_info.indrelid
JOIN pg_catalog.pg_namespace AS table_namespace
  ON table_namespace.oid = table_class.relnamespace
JOIN pg_catalog.pg_class AS index_class
  ON index_class.oid = index_info.indexrelid
CROSS JOIN LATERAL unnest(index_info.indkey)
  WITH ORDINALITY AS key_column(attribute_number, ordinality)
JOIN pg_catalog.pg_attribute AS column_info
  ON column_info.attrelid = table_class.oid
 AND column_info.attnum = key_column.attribute_number
WHERE table_namespace.nspname = 'public'
  AND key_column.ordinality <= index_info.indnkeyatts
  AND table_class.relname IN (
    'user_requests',
    'agent_runs',
    'agent_workspace_leases',
    'agent_generation_leases',
    'agent_generation_jobs',
    'agent_generation_outbox_events',
    'agent_events',
    'agent_checkpoints',
    'agent_tool_executions',
    'agent_missions',
    'agent_mission_nodes',
    'agent_evidence_receipts'
  )
GROUP BY
  table_class.relname,
  index_class.relname,
  index_info.indisunique,
  index_info.indisvalid
ORDER BY table_class.relname, index_class.relname
`;

const CATALOG_FOREIGN_KEYS_SQL = `
SELECT
  child_table.relname AS "tableName",
  constraint_info.conname AS "constraintName",
  array_agg(child_column.attname ORDER BY child_key.ordinality) AS "columns",
  parent_table.relname AS "referencedTableName",
  array_agg(parent_column.attname ORDER BY child_key.ordinality) AS "referencedColumns",
  CASE constraint_info.confdeltype
    WHEN 'a' THEN 'NO ACTION'
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
    WHEN 'd' THEN 'SET DEFAULT'
  END AS "deleteAction",
  CASE constraint_info.confupdtype
    WHEN 'a' THEN 'NO ACTION'
    WHEN 'r' THEN 'RESTRICT'
    WHEN 'c' THEN 'CASCADE'
    WHEN 'n' THEN 'SET NULL'
    WHEN 'd' THEN 'SET DEFAULT'
  END AS "updateAction",
  constraint_info.convalidated AS "validated"
FROM pg_catalog.pg_constraint AS constraint_info
JOIN pg_catalog.pg_class AS child_table
  ON child_table.oid = constraint_info.conrelid
JOIN pg_catalog.pg_namespace AS child_namespace
  ON child_namespace.oid = child_table.relnamespace
JOIN pg_catalog.pg_class AS parent_table
  ON parent_table.oid = constraint_info.confrelid
CROSS JOIN LATERAL unnest(constraint_info.conkey)
  WITH ORDINALITY AS child_key(attribute_number, ordinality)
JOIN LATERAL unnest(constraint_info.confkey)
  WITH ORDINALITY AS parent_key(attribute_number, ordinality)
  ON parent_key.ordinality = child_key.ordinality
JOIN pg_catalog.pg_attribute AS child_column
  ON child_column.attrelid = child_table.oid
 AND child_column.attnum = child_key.attribute_number
JOIN pg_catalog.pg_attribute AS parent_column
  ON parent_column.attrelid = parent_table.oid
 AND parent_column.attnum = parent_key.attribute_number
WHERE constraint_info.contype = 'f'
  AND child_namespace.nspname = 'public'
  AND child_table.relname IN (
    'agent_runs',
    'agent_workspace_leases',
    'agent_generation_leases',
    'agent_generation_jobs',
    'agent_generation_outbox_events',
    'agent_events',
    'agent_checkpoints',
    'agent_tool_executions',
    'agent_missions',
    'agent_mission_nodes',
    'agent_evidence_receipts'
  )
GROUP BY
  child_table.relname,
  constraint_info.conname,
  parent_table.relname,
  constraint_info.confdeltype,
  constraint_info.confupdtype,
  constraint_info.convalidated
ORDER BY child_table.relname, constraint_info.conname
`;

function sameColumns(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((column, index) => column === expected[index])
  );
}

function issueSortKey(issue: MoAgentSchemaIssue): string {
  return `${issue.objectName}:${issue.code}:${issue.expected}:${issue.actual ?? ''}`;
}

export async function readMoAgentSchemaCatalog(
  client: MoAgentSchemaQueryClient
): Promise<MoAgentSchemaCatalog> {
  // Keep these sequential so readiness checks add minimal pressure to a database
  // that may already be unhealthy during process startup.
  const columns = await client.$queryRawUnsafe<MoAgentCatalogColumn[]>(
    CATALOG_COLUMNS_SQL
  );
  const indexes = await client.$queryRawUnsafe<MoAgentCatalogIndex[]>(
    CATALOG_INDEXES_SQL
  );
  const foreignKeys = await client.$queryRawUnsafe<MoAgentCatalogForeignKey[]>(
    CATALOG_FOREIGN_KEYS_SQL
  );
  return { columns, indexes, foreignKeys };
}

export function evaluateMoAgentSchemaCatalog(
  catalog: MoAgentSchemaCatalog
): MoAgentSchemaReadinessReport {
  const issues: MoAgentSchemaIssue[] = [];
  const expectedTables = new Set(EXPECTED_COLUMNS.map((column) => column.tableName));
  const actualTables = new Set(catalog.columns.map((column) => column.tableName));

  for (const tableName of expectedTables) {
    if (!actualTables.has(tableName)) {
      issues.push({
        code: 'MISSING_TABLE',
        objectName: `public.${tableName}`,
        expected: 'table',
      });
    }
  }

  for (const expected of EXPECTED_COLUMNS) {
    if (!actualTables.has(expected.tableName)) continue;
    const actual = catalog.columns.find(
      (column) =>
        column.tableName === expected.tableName &&
        column.columnName === expected.columnName
    );
    const objectName = `public.${expected.tableName}.${expected.columnName}`;
    if (!actual) {
      issues.push({ code: 'MISSING_COLUMN', objectName, expected: expected.dataType });
      continue;
    }
    if (actual.dataType !== expected.dataType) {
      issues.push({
        code: 'COLUMN_TYPE_MISMATCH',
        objectName,
        expected: expected.dataType,
        actual: actual.dataType,
      });
    }
    if (actual.nullable !== expected.nullable) {
      issues.push({
        code: 'COLUMN_NULLABILITY_MISMATCH',
        objectName,
        expected: expected.nullable ? 'nullable' : 'not null',
        actual: actual.nullable ? 'nullable' : 'not null',
      });
    }
  }

  for (const expected of EXPECTED_INDEXES) {
    if (!actualTables.has(expected.tableName)) continue;
    const candidates = catalog.indexes.filter(
      (index) =>
        index.tableName === expected.tableName &&
        sameColumns(index.columns, expected.columns) &&
        (expected.unique === undefined || index.unique === expected.unique)
    );
    const objectName = `public.${expected.tableName}(${expected.columns.join(', ')})`;
    if (candidates.length === 0) {
      issues.push({
        code: 'MISSING_INDEX',
        objectName,
        expected: expected.unique ? 'valid unique index' : 'valid index',
      });
    } else if (!candidates.some((index) => index.valid)) {
      issues.push({
        code: 'INVALID_INDEX',
        objectName,
        expected: 'valid index',
        actual: candidates.map((index) => index.indexName).join(', '),
      });
    }
  }

  for (const expected of EXPECTED_FOREIGN_KEYS) {
    if (
      !actualTables.has(expected.tableName) ||
      !actualTables.has(expected.referencedTableName)
    ) {
      continue;
    }
    const candidates = catalog.foreignKeys.filter(
      (foreignKey) =>
        foreignKey.tableName === expected.tableName &&
        sameColumns(foreignKey.columns, expected.columns) &&
        foreignKey.referencedTableName === expected.referencedTableName &&
        sameColumns(foreignKey.referencedColumns, expected.referencedColumns) &&
        foreignKey.deleteAction === expected.deleteAction &&
        foreignKey.updateAction === expected.updateAction
    );
    const objectName = `public.${expected.tableName}(${expected.columns.join(', ')}) -> public.${expected.referencedTableName}(${expected.referencedColumns.join(', ')})`;
    if (candidates.length === 0) {
      issues.push({
        code: 'MISSING_FOREIGN_KEY',
        objectName,
        expected: `ON DELETE ${expected.deleteAction} ON UPDATE ${expected.updateAction}`,
      });
    } else if (!candidates.some((foreignKey) => foreignKey.validated)) {
      issues.push({
        code: 'UNVALIDATED_FOREIGN_KEY',
        objectName,
        expected: 'validated foreign key',
        actual: candidates.map((foreignKey) => foreignKey.constraintName).join(', '),
      });
    }
  }

  issues.sort((left, right) => issueSortKey(left).localeCompare(issueSortKey(right)));
  return {
    ready: issues.length === 0,
    contractVersion: MOAGENT_SCHEMA_CONTRACT_VERSION,
    issues,
  };
}

export async function inspectMoAgentSchemaReadiness(
  client: MoAgentSchemaQueryClient
): Promise<MoAgentSchemaReadinessReport> {
  return evaluateMoAgentSchemaCatalog(await readMoAgentSchemaCatalog(client));
}

export class MoAgentSchemaNotReadyError extends Error {
  readonly code = 'MOAGENT_SCHEMA_NOT_READY' as const;
  readonly contractVersion = MOAGENT_SCHEMA_CONTRACT_VERSION;
  readonly issues: MoAgentSchemaIssue[];

  constructor(report: MoAgentSchemaReadinessReport) {
    super(
      `MoAgent database schema ${report.contractVersion} is not ready (${report.issues.length} issue${report.issues.length === 1 ? '' : 's'}). Apply the checked-in Prisma migrations before accepting agent runs.`
    );
    this.name = 'MoAgentSchemaNotReadyError';
    this.issues = report.issues;
  }
}

export async function assertMoAgentSchemaReady(
  client: MoAgentSchemaQueryClient
): Promise<MoAgentSchemaReadinessReport> {
  const report = await inspectMoAgentSchemaReadiness(client);
  if (!report.ready) throw new MoAgentSchemaNotReadyError(report);
  return report;
}
