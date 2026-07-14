import fs from 'fs/promises';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { prisma } from '@/lib/db/client';
import { buildModelComparison, buildSkillVersionImpact } from './analysis';
import { getQuantEvalCases, getQuantEvalSets } from './cases';
import {
  DEFAULT_EVAL_CONCURRENCY,
  DEFAULT_EVALUATOR_ID,
  EVAL_CAPABILITY_LABELS,
  EVAL_RUNTIME_OPTIONS,
  EVAL_TYPE_LABELS,
  MAX_EVAL_CONCURRENCY,
} from './constants';
import {
  CASES_PATH,
  LOG_DIR,
  QUEUE_DIR,
  QUEUE_PATH,
  REPAIRS_DIR,
  REPAIRS_PATH,
  REPORTS_DIR,
  ROOT,
  SCHEDULE_PATH,
} from './paths';
import type {
  EvalCheckStatus,
  QuantEvalArtifactSummary,
  QuantEvalCase,
  QuantEvalCheck,
  QuantEvalDashboardData,
  QuantEvalFlowSimulation,
  QuantEvalFlowStep,
  QuantEvalQueueItem,
  QuantEvalQueueStatus,
  QuantEvalRepairTicket,
  QuantEvalResult,
  QuantEvalRun,
  QuantEvalScheduleConfig,
  StartQuantEvalOptions,
  UpdateQuantEvalScheduleInput,
} from './types';
import {
  addHours,
  booleanValue,
  dateOrNow,
  isRecord,
  jsonArray,
  jsonObject,
  numberValue,
  readJson,
  readRecordArray,
  stringArray,
  stringValue,
  toDate,
  uniqueId,
  writeJson,
  type JsonRecord,
} from './runtime-utils';
import { defaultScheduleConfig } from './schedule-defaults';
import {
  normalizeQueueStatus,
  mapDbEvalRun,
  mapDbQueueItem,
  mapDbRepairTicket,
  mapDbSchedule,
  normalizeRun,
} from './runtime-mappers';

export {
  createQuantEvalCase,
  createQuantEvalSet,
  getQuantEvalCases,
  getQuantEvalSets,
} from './cases';

let queueKickoffInProgress = false;
const runningChildren = new Map<string, ChildProcess>();
const EVAL_CLI = 'claude';
const EVAL_MODEL = 'deepseek-v4-flash';

function supportsReasoningEffort(cli: string | null | undefined): boolean {
  return EVAL_RUNTIME_OPTIONS.some((option) => option.cli === cli && option.supportsReasoningEffort);
}

function normalizeEvaluatorId(value: unknown): string {
  const normalized = stringValue(value, DEFAULT_EVALUATOR_ID).trim();
  return normalized || DEFAULT_EVALUATOR_ID;
}

function normalizeEvalConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_EVAL_CONCURRENCY;
  }
  return Math.min(MAX_EVAL_CONCURRENCY, Math.max(1, Math.floor(value)));
}

async function writeEvalRunToDatabase(run: QuantEvalRun): Promise<void> {
  await prisma.evalRun.upsert({
    where: { id: run.id },
    update: {
      fileName: run.fileName,
      filePath: run.filePath,
      reportCreatedAt: dateOrNow(run.createdAt),
      mtimeMs: run.mtimeMs,
      passed: run.passed,
      total: run.total,
      passedCount: run.passedCount,
      failedCount: run.failedCount,
      passRate: run.passRate,
      averageScore: run.averageScore,
      durationMs: run.durationMs,
      metadata: jsonObject(run.metadata),
      coverage: jsonObject(run.coverage),
      results: jsonArray(run.results),
    },
    create: {
      id: run.id,
      fileName: run.fileName,
      filePath: run.filePath,
      reportCreatedAt: dateOrNow(run.createdAt),
      mtimeMs: run.mtimeMs,
      passed: run.passed,
      total: run.total,
      passedCount: run.passedCount,
      failedCount: run.failedCount,
      passRate: run.passRate,
      averageScore: run.averageScore,
      durationMs: run.durationMs,
      metadata: jsonObject(run.metadata),
      coverage: jsonObject(run.coverage),
      results: jsonArray(run.results),
    },
  });
}

async function listEvalRunsFromDatabase(limit: number): Promise<QuantEvalRun[]> {
  const records = await prisma.evalRun.findMany({
    orderBy: { reportCreatedAt: 'desc' },
    take: limit,
  });
  return records.map(mapDbEvalRun);
}

async function readQueue(): Promise<QuantEvalQueueItem[]> {
  const dbItems = await prisma.evalQueueItem
    .findMany({ orderBy: { createdAt: 'desc' }, take: 50 })
    .then((items) => items.map((item) => ({
      ...mapDbQueueItem(item),
      cli: EVAL_CLI,
      model: EVAL_MODEL,
      reasoningEffort: '',
    })))
    .catch(() => []);
  const parsed = await readJson(QUEUE_PATH).catch(() => []);
  const items = Array.isArray(parsed) ? parsed : [];
  const fileItems = items
    .filter(isRecord)
    .map((item): QuantEvalQueueItem => ({
      id: stringValue(item.id),
      status: normalizeQueueStatus(item.status),
      createdAt: stringValue(item.createdAt, new Date().toISOString()),
      startedAt: stringValue(item.startedAt) || null,
      finishedAt: stringValue(item.finishedAt) || null,
      cli: EVAL_CLI,
      model: EVAL_MODEL,
      reasoningEffort: '',
      evaluatorId: normalizeEvaluatorId(item.evaluatorId),
      concurrency: normalizeEvalConcurrency(item.concurrency),
      selectedCases: stringArray(item.selectedCases),
      limit: typeof item.limit === 'number' ? item.limit : null,
      keepProjects: booleanValue(item.keepProjects),
      reportId: stringValue(item.reportId) || null,
      reportPath: stringValue(item.reportPath) || null,
      logPath: stringValue(item.logPath) || null,
      pid: typeof item.pid === 'number' ? item.pid : null,
      exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
      error: stringValue(item.error) || null,
    }))
    .filter((item) => item.id);
  const byId = new Map<string, QuantEvalQueueItem>();
  for (const item of fileItems) byId.set(item.id, item);
  for (const item of dbItems) {
    const fileItem = byId.get(item.id);
    byId.set(item.id, {
      ...fileItem,
      ...item,
      evaluatorId: fileItem?.evaluatorId ?? item.evaluatorId,
      concurrency: fileItem?.concurrency ?? item.concurrency,
    });
  }
  return Array.from(byId.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50);
}

async function writeQueue(items: QuantEvalQueueItem[]): Promise<void> {
  const limited = items.slice(0, 80);
  await Promise.all([
    writeJson(QUEUE_PATH, limited).catch(() => undefined),
    Promise.all(limited.map((item) => prisma.evalQueueItem.upsert({
      where: { id: item.id },
      update: {
        status: item.status,
        cli: item.cli,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        selectedCases: jsonArray(item.selectedCases),
        limit: item.limit,
        keepProjects: item.keepProjects,
        reportId: item.reportId,
        reportPath: item.reportPath,
        logPath: item.logPath,
        pid: item.pid,
        exitCode: item.exitCode,
        error: item.error,
        createdAt: dateOrNow(item.createdAt),
        startedAt: toDate(item.startedAt),
        finishedAt: toDate(item.finishedAt),
      },
      create: {
        id: item.id,
        status: item.status,
        cli: item.cli,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        selectedCases: jsonArray(item.selectedCases),
        limit: item.limit,
        keepProjects: item.keepProjects,
        reportId: item.reportId,
        reportPath: item.reportPath,
        logPath: item.logPath,
        pid: item.pid,
        exitCode: item.exitCode,
        error: item.error,
        createdAt: dateOrNow(item.createdAt),
        startedAt: toDate(item.startedAt),
        finishedAt: toDate(item.finishedAt),
      },
    }))),
  ]);
}

function buildVirtualQueueItem(options: StartQuantEvalOptions = {}): QuantEvalQueueItem {
  const selectedCases = Array.isArray(options.selectedCases)
    ? options.selectedCases.map(String).filter(Boolean)
    : [];
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : null;

  return {
    id: 'eval-run-simulation',
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    cli: EVAL_CLI,
    model: EVAL_MODEL,
    reasoningEffort: '',
    evaluatorId: normalizeEvaluatorId(options.evaluatorId),
    concurrency: normalizeEvalConcurrency(options.concurrency),
    selectedCases,
    limit,
    keepProjects: Boolean(options.keepProjects),
    reportId: null,
    reportPath: null,
    logPath: null,
    pid: null,
    exitCode: null,
    error: null,
  };
}

async function updateQueueItem(id: string, patch: Partial<QuantEvalQueueItem>): Promise<QuantEvalQueueItem | null> {
  const queue = await readQueue();
  const index = queue.findIndex((item) => item.id === id);
  if (index < 0) return null;
  queue[index] = { ...queue[index], ...patch };
  await writeQueue(queue);
  return queue[index];
}

async function latestReportAfter(startedAtMs: number): Promise<QuantEvalRun | null> {
  const runs = await getQuantEvalRuns(5);
  return runs.find((run) => run.mtimeMs >= startedAtMs - 1000) ?? null;
}

async function readRepairTickets(): Promise<QuantEvalRepairTicket[]> {
  const dbTickets = await prisma.evalRepairTicket
    .findMany({ orderBy: { createdAt: 'desc' } })
    .then((items) => items.map(mapDbRepairTicket))
    .catch(() => []);
  const parsed = await readJson(REPAIRS_PATH).catch(() => []);
  const items = Array.isArray(parsed) ? parsed : [];
  const fileTickets = items
    .filter(isRecord)
    .map((item): QuantEvalRepairTicket => ({
      id: stringValue(item.id),
      runId: stringValue(item.runId),
      caseId: stringValue(item.caseId),
      title: stringValue(item.title, '未命名修复单'),
      status: item.status === 'resolved' ? 'resolved' : 'open',
      severity: item.severity === 'high' ? 'high' : 'medium',
      createdAt: stringValue(item.createdAt, new Date().toISOString()),
      updatedAt: stringValue(item.updatedAt, new Date().toISOString()),
      model: stringValue(item.model),
      reportPath: stringValue(item.reportPath),
      projectId: stringValue(item.projectId) || null,
      failures: stringArray(item.failures),
      validationSummaries: stringArray(item.validationSummaries),
      suggestedActions: stringArray(item.suggestedActions),
      skillVersions: isRecord(item.skillVersions)
        ? Object.fromEntries(Object.entries(item.skillVersions).map(([key, value]) => [key, stringValue(value) || null]))
        : {},
    }))
    .filter((item) => item.id);
  const byId = new Map<string, QuantEvalRepairTicket>();
  for (const item of fileTickets) byId.set(item.id, item);
  for (const item of dbTickets) byId.set(item.id, item);
  return Array.from(byId.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

async function writeRepairTickets(items: QuantEvalRepairTicket[]): Promise<void> {
  const limited = items.slice(0, 200);
  await Promise.all([
    writeJson(REPAIRS_PATH, limited).catch(() => undefined),
    Promise.all(limited.map((item) => prisma.evalRepairTicket.upsert({
      where: { id: item.id },
      update: {
        runId: item.runId,
        caseId: item.caseId,
        title: item.title,
        status: item.status,
        severity: item.severity,
        model: item.model,
        reportPath: item.reportPath,
        projectId: item.projectId,
        failures: jsonArray(item.failures),
        validationSummaries: jsonArray(item.validationSummaries),
        suggestedActions: jsonArray(item.suggestedActions),
        skillVersions: jsonObject(item.skillVersions),
        createdAt: dateOrNow(item.createdAt),
        updatedAt: dateOrNow(item.updatedAt),
      },
      create: {
        id: item.id,
        runId: item.runId,
        caseId: item.caseId,
        title: item.title,
        status: item.status,
        severity: item.severity,
        model: item.model,
        reportPath: item.reportPath,
        projectId: item.projectId,
        failures: jsonArray(item.failures),
        validationSummaries: jsonArray(item.validationSummaries),
        suggestedActions: jsonArray(item.suggestedActions),
        skillVersions: jsonObject(item.skillVersions),
        createdAt: dateOrNow(item.createdAt),
        updatedAt: dateOrNow(item.updatedAt),
      },
    }))),
  ]);
}

function suggestedActionsForResult(result: QuantEvalResult): string[] {
  const actions = new Set<string>();
  result.validationChecks.forEach((check) => {
    if (check.status !== 'failed') return;
    if (check.id.includes('build')) actions.add('检查生成项目依赖和 Next.js build 输出，优先修复编译错误。');
    if (check.id.includes('chart')) actions.add('检查可视化模板是否生成 K 线、成交量或场景化图表容器。');
    if (check.id.includes('market')) actions.add('确认 /api/market 同源代理和后端 8000 数据服务可用。');
    if (check.id.includes('artifact')) actions.add('清理外部 CDN、mock 数据、明文密钥和非标准数据绑定。');
    if (check.id.includes('data')) actions.add('检查 data_file/final/dashboard-data.json、evidence/sources.json 和 data_quality.json。');
  });
  if (result.eventAudit?.errorCount) {
    actions.add('检查 .quantpilot/events.jsonl 中 error 事件，补齐阶段化执行事件。');
  }
  if (!actions.size) {
    actions.add('查看失败用例的 failures 和 validation checks，定位生成链路的第一个失败点。');
  }
  return Array.from(actions);
}

async function createRepairTicketsForRun(run: QuantEvalRun): Promise<QuantEvalRepairTicket[]> {
  if (run.passed) return readRepairTickets();
  const existing = await readRepairTickets();
  const existingKeys = new Set(existing.map((ticket) => `${ticket.runId}:${ticket.caseId}`));
  const skillVersions = Object.fromEntries(
    Object.entries(run.metadata.skillLockSnapshot.skills).map(([skillId, entry]) => [skillId, entry.version])
  );
  const createdAt = new Date().toISOString();
  const newTickets = run.results
    .filter((result) => !result.passed)
    .filter((result) => !existingKeys.has(`${run.id}:${result.id}`))
    .map((result): QuantEvalRepairTicket => ({
      id: uniqueId('repair'),
      runId: run.id,
      caseId: result.id,
      title: `${result.name} 回归失败`,
      status: 'open',
      severity: result.validationChecks.some((check) => check.status === 'failed') ? 'high' : 'medium',
      createdAt,
      updatedAt: createdAt,
      model: `${run.metadata.runtime.cli ?? '-'} / ${run.metadata.runtime.model ?? '-'}`,
      reportPath: run.filePath,
      projectId: result.projectId,
      failures: result.failures,
      validationSummaries: result.validationChecks
        .filter((check) => check.status !== 'passed')
        .map((check) => `${check.name || check.id}: ${check.summary}`),
      suggestedActions: suggestedActionsForResult(result),
      skillVersions,
    }));
  if (!newTickets.length) return existing;
  const merged = [...newTickets, ...existing];
  await writeRepairTickets(merged);
  return merged;
}

async function readScheduleConfig(): Promise<QuantEvalScheduleConfig> {
  const dbSchedule = await prisma.evalSchedule
    .findUnique({ where: { id: 'default' } })
    .then((record) => record ? mapDbSchedule(record) : null)
    .catch(() => null);
  if (dbSchedule) {
    return {
      ...dbSchedule,
      cli: EVAL_CLI,
      model: EVAL_MODEL,
      reasoningEffort: '',
    };
  }

  const parsed = await readJson(SCHEDULE_PATH).catch(() => null);
  const record = isRecord(parsed) ? parsed : {};
  return {
    ...defaultScheduleConfig(),
    enabled: booleanValue(record.enabled),
    intervalHours:
      typeof record.intervalHours === 'number' && Number.isFinite(record.intervalHours) && record.intervalHours > 0
        ? Math.min(168, Math.max(1, Math.floor(record.intervalHours)))
        : 24,
    cli: EVAL_CLI,
    model: EVAL_MODEL,
    reasoningEffort: '',
    selectedCases: stringArray(record.selectedCases),
    limit: typeof record.limit === 'number' ? record.limit : null,
    keepProjects: booleanValue(record.keepProjects),
    nextRunAt: stringValue(record.nextRunAt) || null,
    lastRunAt: stringValue(record.lastRunAt) || null,
    lastQueuedRunId: stringValue(record.lastQueuedRunId) || null,
    updatedAt: stringValue(record.updatedAt) || null,
  };
}

async function writeScheduleConfig(config: QuantEvalScheduleConfig): Promise<QuantEvalScheduleConfig> {
  const lockedConfig = {
    ...config,
    cli: EVAL_CLI,
    model: EVAL_MODEL,
    reasoningEffort: '',
  };
  await Promise.all([
    writeJson(SCHEDULE_PATH, lockedConfig).catch(() => undefined),
    prisma.evalSchedule.upsert({
      where: { id: 'default' },
      update: {
        enabled: config.enabled,
        intervalHours: config.intervalHours,
        cli: lockedConfig.cli,
        model: lockedConfig.model,
        reasoningEffort: lockedConfig.reasoningEffort,
        selectedCases: jsonArray(config.selectedCases),
        limit: config.limit,
        keepProjects: config.keepProjects,
        nextRunAt: toDate(config.nextRunAt),
        lastRunAt: toDate(config.lastRunAt),
        lastQueuedRunId: config.lastQueuedRunId,
      },
      create: {
        id: 'default',
        enabled: config.enabled,
        intervalHours: config.intervalHours,
        cli: lockedConfig.cli,
        model: lockedConfig.model,
        reasoningEffort: lockedConfig.reasoningEffort,
        selectedCases: jsonArray(config.selectedCases),
        limit: config.limit,
        keepProjects: config.keepProjects,
        nextRunAt: toDate(config.nextRunAt),
        lastRunAt: toDate(config.lastRunAt),
        lastQueuedRunId: config.lastQueuedRunId,
      },
    }),
  ]);
  return lockedConfig;
}

function buildBenchmarkArgs(item: QuantEvalQueueItem): string[] {
  const args = [
    'scripts/evals/run-quant-benchmarks.js',
    '--trigger=eval-backend',
    `--evaluator=${item.evaluatorId}`,
    `--concurrency=${item.concurrency}`,
    `--cli=${item.cli}`,
    `--model=${item.model}`,
  ];
  if (supportsReasoningEffort(item.cli)) {
    args.push(`--reasoning-effort=${item.reasoningEffort || 'low'}`);
  }

  item.selectedCases.forEach((caseId) => {
    args.push('--case', caseId);
  });
  if (item.limit) {
    args.push('--limit', String(item.limit));
  }
  if (item.keepProjects) {
    args.push('--keep-projects');
  }
  return args;
}

function runBenchmarkQueueItem(item: QuantEvalQueueItem) {
  const startedAtMs = Date.now();
  const logPath = path.join(LOG_DIR, `${item.id}.log`);
  void (async () => {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await updateQueueItem(item.id, {
      status: 'running',
      startedAt: new Date(startedAtMs).toISOString(),
      logPath: path.relative(ROOT, logPath),
      error: null,
    });

    const args = buildBenchmarkArgs(item);
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        QUANTPILOT_EVAL_TRIGGER: 'eval-backend',
        QUANTPILOT_EVAL_EVALUATOR: item.evaluatorId,
        QUANTPILOT_EVAL_CONCURRENCY: String(item.concurrency),
        QUANTPILOT_EVAL_CLI: item.cli,
        QUANTPILOT_EVAL_MODEL: item.model,
        ...(supportsReasoningEffort(item.cli) ? { QUANTPILOT_EVAL_REASONING_EFFORT: item.reasoningEffort || 'low' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningChildren.set(item.id, child);
    await updateQueueItem(item.id, { pid: child.pid ?? null });

    const appendLog = async (chunk: Buffer | string) => {
      await fs.appendFile(logPath, chunk);
    };

    child.stdout.on('data', (chunk) => {
      void appendLog(chunk);
    });
    child.stderr.on('data', (chunk) => {
      void appendLog(chunk);
    });
    child.on('error', (error) => {
      void (async () => {
        const current = (await readQueue()).find((entry) => entry.id === item.id);
        if (current?.status === 'cancelled') {
          runningChildren.delete(item.id);
          await processEvalQueue();
          return;
        }
        await updateQueueItem(item.id, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          exitCode: null,
          error: error.message,
        });
        runningChildren.delete(item.id);
        await processEvalQueue();
      })();
    });
    child.on('close', (code, signal) => {
      void (async () => {
        const current = (await readQueue()).find((entry) => entry.id === item.id);
        if (current?.status === 'cancelled') {
          runningChildren.delete(item.id);
          await processEvalQueue();
          return;
        }
        const report = await latestReportAfter(startedAtMs);
        await updateQueueItem(item.id, {
          status: code === 0 ? 'passed' : 'failed',
          finishedAt: new Date().toISOString(),
          exitCode: code,
          reportId: report?.id ?? null,
          reportPath: report?.filePath ?? null,
          error: code === 0 ? null : `benchmark 退出码 ${code ?? signal ?? 'unknown'}`,
        });
        runningChildren.delete(item.id);
        if (report && !report.passed) {
          await createRepairTicketsForRun(report);
        }
        await processEvalQueue();
      })();
    });
  })();
}

async function processEvalQueue(): Promise<void> {
  if (queueKickoffInProgress) return;
  queueKickoffInProgress = true;
  try {
    const queue = await readQueue();
    if (queue.some((item) => item.status === 'running')) {
      return;
    }
    const next = queue
      .filter((item) => item.status === 'queued')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
    if (!next) return;
    runBenchmarkQueueItem(next);
  } finally {
    queueKickoffInProgress = false;
  }
}

export async function getQuantEvalRuns(limit = 30): Promise<QuantEvalRun[]> {
  const cases = await getQuantEvalCases();
  const dbRuns = await listEvalRunsFromDatabase(limit).catch(() => []);
  const files = await fs
    .readdir(REPORTS_DIR)
    .then((items) => items.filter((item) => /^report-\d+\.json$/.test(item)))
    .catch(() => []);

  const runs = await Promise.all(
    files.map(async (fileName) => {
      const filePath = path.join(REPORTS_DIR, fileName);
      const stat = await fs.stat(filePath);
      const parsed = await readJson(filePath);
      return normalizeRun(filePath, stat.mtimeMs, isRecord(parsed) ? parsed : {}, cases);
    })
  );

  await Promise.all(runs.map((run) => writeEvalRunToDatabase(run).catch(() => undefined)));

  const byId = new Map<string, QuantEvalRun>();
  for (const run of dbRuns) byId.set(run.id, run);
  for (const run of runs) byId.set(run.id, run);
  return Array.from(byId.values()).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

export async function getQuantEvalQueue(): Promise<QuantEvalQueueItem[]> {
  return readQueue();
}

export async function cancelQuantEvalRun(queueId: string): Promise<QuantEvalQueueItem> {
  const queue = await readQueue();
  const item = queue.find((entry) => entry.id === queueId);
  if (!item) {
    throw new Error('未找到评测队列任务。');
  }
  if (item.status !== 'queued' && item.status !== 'running') {
    return item;
  }

  if (item.status === 'running') {
    const child = runningChildren.get(item.id);
    if (child && !child.killed) {
      child.kill('SIGTERM');
    } else if (item.pid) {
      try {
        process.kill(item.pid, 'SIGTERM');
      } catch {
        // 进程可能已经自然退出，队列状态仍然按取消处理。
      }
    }
    runningChildren.delete(item.id);
  }

  const updated = await updateQueueItem(item.id, {
    status: 'cancelled',
    finishedAt: new Date().toISOString(),
    error: '用户取消评测任务。',
    exitCode: null,
  });
  await processEvalQueue();
  if (!updated) {
    throw new Error('取消评测任务失败。');
  }
  return updated;
}

export async function simulateQuantEvalFlow(options: StartQuantEvalOptions = {}): Promise<QuantEvalFlowSimulation> {
  const generatedAt = new Date().toISOString();
  const steps: QuantEvalFlowStep[] = [];
  const warnings: string[] = [];
  const allCases = await getQuantEvalCases();
  const selectedCases = Array.isArray(options.selectedCases)
    ? options.selectedCases.map(String).filter(Boolean)
    : [];
  const selectedSet = selectedCases.length
    ? allCases.filter((testCase) => selectedCases.includes(testCase.id))
    : allCases;
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
      ? Math.floor(options.limit)
      : null;
  const scopedCases = limit ? selectedSet.slice(0, limit) : selectedSet;
  const missingCases = selectedCases.filter((caseId) => !allCases.some((testCase) => testCase.id === caseId));
  const virtualItem = buildVirtualQueueItem({ ...options, selectedCases, limit });
  const command = [process.execPath, ...buildBenchmarkArgs(virtualItem)];

  const pushStep = (step: QuantEvalFlowStep) => {
    steps.push(step);
    if (step.status === 'warning') {
      warnings.push(step.summary);
    }
  };

  pushStep({
    id: 'case-selection',
    name: '用例选择',
    status: scopedCases.length && !missingCases.length ? 'passed' : 'failed',
    summary: scopedCases.length
      ? `已选择 ${scopedCases.length} 个用例。`
      : '没有匹配的评测用例。',
    detail: missingCases.length ? `未找到用例：${missingCases.join(', ')}` : null,
  });

  pushStep({
    id: 'evaluator',
    name: '评测器配置',
    status: virtualItem.evaluatorId ? 'passed' : 'failed',
    summary: `${virtualItem.evaluatorId} · 并发上限 ${virtualItem.concurrency}`,
    detail: null,
  });

  const runtime = EVAL_RUNTIME_OPTIONS.find((option) => option.cli === virtualItem.cli);
  const modelKnown = runtime?.models.some((model) => model.id === virtualItem.model);
  pushStep({
    id: 'runtime',
    name: '底层执行能力',
    status: runtime && modelKnown ? 'passed' : runtime ? 'warning' : 'failed',
    summary: runtime
      ? '已匹配评测器所需的执行能力。'
      : `未注册执行能力：${virtualItem.cli}`,
    detail: runtime && !modelKnown ? '底层模型不在运行器白名单内，将按传入配置尝试执行。' : null,
  });

  const benchmarkScript = path.join(ROOT, 'scripts', 'evals', 'run-quant-benchmarks.js');
  const scriptStat = await fs.stat(benchmarkScript).catch(() => null);
  pushStep({
    id: 'benchmark-script',
    name: 'Benchmark 脚本',
    status: scriptStat ? 'passed' : 'failed',
    summary: scriptStat ? 'benchmark 入口脚本存在。' : 'benchmark 入口脚本缺失。',
    detail: path.relative(ROOT, benchmarkScript),
  });

  const queueReady = await fs.mkdir(QUEUE_DIR, { recursive: true }).then(() => true).catch(() => false);
  const logReady = await fs.mkdir(LOG_DIR, { recursive: true }).then(() => true).catch(() => false);
  const reportReady = await fs.mkdir(REPORTS_DIR, { recursive: true }).then(() => true).catch(() => false);
  const repairReady = await fs.mkdir(REPAIRS_DIR, { recursive: true }).then(() => true).catch(() => false);
  pushStep({
    id: 'storage',
    name: '本地存储',
    status: queueReady && logReady && reportReady && repairReady ? 'passed' : 'failed',
    summary: queueReady && logReady && reportReady && repairReady
      ? '队列、日志、报告和修复单目录可写。'
      : '部分评测目录不可写。',
    detail: [QUEUE_DIR, LOG_DIR, REPORTS_DIR, REPAIRS_DIR].map((item) => path.relative(ROOT, item)).join(' · '),
  });

  const runs = await getQuantEvalRuns(3);
  pushStep({
    id: 'report-parser',
    name: '报告解析',
    status: runs.length ? 'passed' : 'warning',
    summary: runs.length ? `已解析 ${runs.length} 份最近报告。` : '暂无历史报告，首次运行后才会生成运行记录。',
    detail: runs[0]?.filePath ?? null,
  });

  const tickets = await readRepairTickets();
  pushStep({
    id: 'repair-sink',
    name: '修复单沉淀',
    status: 'passed',
    summary: `修复单存储可读，当前 ${tickets.length} 条。`,
    detail: path.relative(ROOT, REPAIRS_PATH),
  });

  pushStep({
    id: 'command',
    name: '执行命令',
    status: command.length > 2 ? 'passed' : 'failed',
    summary: '已生成 benchmark 执行命令。',
    detail: command.join(' '),
  });

  return {
    generatedAt,
    ready: steps.every((step) => step.status !== 'failed'),
    runtime: {
      cli: virtualItem.cli,
      model: virtualItem.model,
      reasoningEffort: virtualItem.reasoningEffort,
    },
    evaluator: {
      id: virtualItem.evaluatorId,
      concurrency: virtualItem.concurrency,
    },
    selection: {
      selectedCases,
      limit,
      keepProjects: virtualItem.keepProjects,
      caseCount: scopedCases.length,
      concurrency: virtualItem.concurrency,
    },
    selectedCaseIds: scopedCases.map((testCase) => testCase.id),
    command,
    steps,
    warnings,
  };
}

export async function startQuantEvalRun(options: StartQuantEvalOptions = {}): Promise<QuantEvalQueueItem> {
  const queue = await readQueue();
  const item: QuantEvalQueueItem = {
    ...buildVirtualQueueItem(options),
    id: uniqueId('eval-run'),
    createdAt: new Date().toISOString(),
  };

  await writeQueue([item, ...queue]);
  await processEvalQueue();
  return item;
}

export async function updateQuantEvalSchedule(input: UpdateQuantEvalScheduleInput): Promise<QuantEvalScheduleConfig> {
  const current = await readScheduleConfig();
  const intervalHours =
    typeof input.intervalHours === 'number' && Number.isFinite(input.intervalHours) && input.intervalHours > 0
      ? Math.min(168, Math.max(1, Math.floor(input.intervalHours)))
      : current.intervalHours;
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : current.enabled;
  const now = new Date();
  const nextRunAt =
    input.nextRunAt !== undefined
      ? input.nextRunAt
      : enabled
        ? current.nextRunAt ?? addHours(now, intervalHours).toISOString()
        : null;
  return writeScheduleConfig({
    ...current,
    enabled,
    intervalHours,
    cli: EVAL_CLI,
    model: EVAL_MODEL,
    reasoningEffort: '',
    selectedCases: Array.isArray(input.selectedCases) ? input.selectedCases.map(String).filter(Boolean) : current.selectedCases,
    limit:
      input.limit === null
        ? null
        : typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
          ? Math.floor(input.limit)
          : current.limit,
    keepProjects: typeof input.keepProjects === 'boolean' ? input.keepProjects : current.keepProjects,
    nextRunAt,
    updatedAt: now.toISOString(),
  });
}

export async function checkQuantEvalSchedule(): Promise<{ queued: boolean; schedule: QuantEvalScheduleConfig; item: QuantEvalQueueItem | null }> {
  const schedule = await readScheduleConfig();
  if (!schedule.enabled || !schedule.nextRunAt) {
    return { queued: false, schedule, item: null };
  }
  const now = new Date();
  if (new Date(schedule.nextRunAt).getTime() > now.getTime()) {
    return { queued: false, schedule, item: null };
  }
  const item = await startQuantEvalRun({
    cli: schedule.cli,
    model: schedule.model,
    reasoningEffort: schedule.reasoningEffort,
    selectedCases: schedule.selectedCases,
    limit: schedule.limit,
    keepProjects: schedule.keepProjects,
  });
  const updated = await writeScheduleConfig({
    ...schedule,
    lastRunAt: now.toISOString(),
    lastQueuedRunId: item.id,
    nextRunAt: addHours(now, schedule.intervalHours).toISOString(),
    updatedAt: now.toISOString(),
  });
  return { queued: true, schedule: updated, item };
}

export async function getQuantEvalRun(runId: string): Promise<QuantEvalRun | null> {
  if (!/^report-\d+$/.test(runId)) {
    return null;
  }
  const cases = await getQuantEvalCases();
  const filePath = path.join(REPORTS_DIR, `${runId}.json`);
  const stat = await fs.stat(filePath).catch(() => null);
  if (stat) {
    const parsed = await readJson(filePath).catch(() => null);
    if (isRecord(parsed)) {
      const run = normalizeRun(filePath, stat.mtimeMs, parsed, cases);
      await writeEvalRunToDatabase(run).catch(() => undefined);
      return run;
    }
  }

  return prisma.evalRun
    .findUnique({ where: { id: runId } })
    .then((record) => record ? mapDbEvalRun(record) : null)
    .catch(() => null);
}

export async function getQuantEvalDashboardData(): Promise<QuantEvalDashboardData> {
  const [cases, customEvalSets, runs, queue, repairTickets, schedule] = await Promise.all([
    getQuantEvalCases(),
    getQuantEvalSets(),
    getQuantEvalRuns(),
    getQuantEvalQueue(),
    readRepairTickets(),
    readScheduleConfig(),
  ]);
  const latestRun = runs[0] ?? null;
  const capabilities = new Set(cases.map((testCase) => testCase.capabilityId));

  return {
    generatedAt: new Date().toISOString(),
    reportsDir: path.relative(ROOT, REPORTS_DIR),
    casesPath: path.relative(ROOT, CASES_PATH),
    runtimeOptions: EVAL_RUNTIME_OPTIONS,
    cases,
    customEvalSets,
    runs,
    queue,
    repairTickets,
    schedule,
    latestRun,
    modelComparison: buildModelComparison(runs),
    skillVersionImpact: buildSkillVersionImpact(runs),
    summary: {
      caseCount: cases.length,
      reportCount: runs.length,
      capabilityCount: capabilities.size,
      latestPassRate: latestRun?.passRate ?? 0,
      latestAverageScore: latestRun?.averageScore ?? 0,
      latestPassedCount: latestRun?.passedCount ?? 0,
      latestFailedCount: latestRun?.failedCount ?? 0,
      latestTotal: latestRun?.total ?? 0,
    },
  };
}
