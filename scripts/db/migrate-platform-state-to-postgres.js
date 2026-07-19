#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const ROOT = path.join(__dirname, '..', '..');
const SETTINGS_FILE = path.join(ROOT, 'data', 'global-settings.json');
const STRATEGY_SCANS_DIR = path.resolve(ROOT, process.env.STRATEGY_SCANS_DIR || path.join('data', 'strategy-scans'));
const RUNS_DIR = path.join(STRATEGY_SCANS_DIR, 'runs');
const JOBS_DIR = path.join(STRATEGY_SCANS_DIR, 'jobs');
const EVAL_REPORTS_DIR = path.join(ROOT, 'tmp', 'quantpilot-benchmark-reports');
const EVAL_QUEUE_PATH = path.join(ROOT, 'tmp', 'quantpilot-eval-queue', 'queue.json');
const EVAL_SCHEDULE_PATH = path.join(ROOT, 'tmp', 'quantpilot-eval-queue', 'schedule.json');
const EVAL_REPAIRS_PATH = path.join(ROOT, 'tmp', 'quantpilot-eval-repairs', 'repairs.json');

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function jsonFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(dirPath, entry.name));
}

function toDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

async function migrateSettings() {
  const existing = await prisma.platformSetting.findUnique({ where: { key: 'global' } });
  if (existing) {
    return { created: 0, skipped: 1 };
  }

  const settings = await readJson(SETTINGS_FILE);
  if (!settings) {
    return { created: 0, skipped: 0 };
  }

  await prisma.platformSetting.create({
    data: {
      key: 'global',
      value: settings,
    },
  });
  return { created: 1, skipped: 0 };
}

async function migrateRun(run) {
  if (!run?.id || !run.templateId || !run.scanId) return false;
  await prisma.strategyScanRun.upsert({
    where: { id: run.id },
    update: {
      templateId: run.templateId,
      scanId: run.scanId,
      symbol: run.symbol || '510300',
      status: run.status || 'failed',
      startedAt: toDate(run.startedAt),
      completedAt: toDate(run.completedAt),
      total: Number(run.total || 0),
      succeeded: Number(run.succeeded || 0),
      failed: Number(run.failed || 0),
      bestResultId: run.bestResultId ?? null,
      objective: run.objective || '',
      source: run.source || '',
      results: Array.isArray(run.results) ? run.results : [],
    },
    create: {
      id: run.id,
      templateId: run.templateId,
      scanId: run.scanId,
      symbol: run.symbol || '510300',
      status: run.status || 'failed',
      startedAt: toDate(run.startedAt),
      completedAt: toDate(run.completedAt),
      total: Number(run.total || 0),
      succeeded: Number(run.succeeded || 0),
      failed: Number(run.failed || 0),
      bestResultId: run.bestResultId ?? null,
      objective: run.objective || '',
      source: run.source || '',
      results: Array.isArray(run.results) ? run.results : [],
    },
  });
  return true;
}

async function migrateJob(job) {
  if (!job?.id || !job.templateId || !job.scanId) return false;
  await prisma.strategyScanJob.upsert({
    where: { id: job.id },
    update: {
      templateId: job.templateId,
      scanId: job.scanId,
      symbol: job.symbol || '510300',
      status: job.status || 'failed',
      startedAt: job.startedAt ? toDate(job.startedAt) : null,
      completedAt: job.completedAt ? toDate(job.completedAt) : null,
      runId: job.runId ?? null,
      error: job.error ?? null,
      createdAt: toDate(job.createdAt),
      updatedAt: toDate(job.updatedAt),
    },
    create: {
      id: job.id,
      templateId: job.templateId,
      scanId: job.scanId,
      symbol: job.symbol || '510300',
      status: job.status || 'failed',
      startedAt: job.startedAt ? toDate(job.startedAt) : null,
      completedAt: job.completedAt ? toDate(job.completedAt) : null,
      runId: job.runId ?? null,
      error: job.error ?? null,
      createdAt: toDate(job.createdAt),
      updatedAt: toDate(job.updatedAt),
    },
  });
  return true;
}

async function migrateStrategyScans() {
  const runFiles = [
    ...(await jsonFiles(RUNS_DIR)),
    ...(await jsonFiles(STRATEGY_SCANS_DIR)),
  ];
  const jobFiles = await jsonFiles(JOBS_DIR);
  let runs = 0;
  let jobs = 0;

  for (const filePath of runFiles) {
    const run = await readJson(filePath);
    if (await migrateRun(run)) runs += 1;
  }

  for (const filePath of jobFiles) {
    const job = await readJson(filePath);
    if (await migrateJob(job)) jobs += 1;
  }

  return { runs, jobs };
}

function normalizeEvalRun(filePath, report, stat) {
  const fileName = path.basename(filePath);
  const id = fileName.replace(/\.json$/, '');
  const results = Array.isArray(report?.results) ? report.results : [];
  const total = Number(report?.total ?? results.length);
  const passedCount = Number(report?.passedCount ?? results.filter((result) => result?.passed).length);
  const failedCount = Number(report?.failedCount ?? Math.max(0, total - passedCount));
  return {
    id,
    fileName,
    filePath: path.relative(ROOT, filePath),
    reportCreatedAt: toDate(report?.createdAt || stat.mtime.toISOString()),
    mtimeMs: stat.mtimeMs,
    passed: Boolean(report?.passed ?? failedCount === 0),
    total,
    passedCount,
    failedCount,
    passRate: total ? Math.round((passedCount / total) * 100) : 0,
    averageScore: Number(report?.averageScore || 0),
    durationMs: results.reduce((sum, result) => sum + Number(result?.durationMs || 0), 0),
    metadata: report?.metadata && typeof report.metadata === 'object' ? report.metadata : {},
    coverage: report?.coverage && typeof report.coverage === 'object' ? report.coverage : {},
    results,
  };
}

async function migrateEvalRuns() {
  const files = await jsonFiles(EVAL_REPORTS_DIR);
  let count = 0;
  for (const filePath of files.filter((item) => /^report-\d+\.json$/.test(path.basename(item)))) {
    const report = await readJson(filePath);
    if (!report) continue;
    const stat = await fs.stat(filePath);
    const run = normalizeEvalRun(filePath, report, stat);
    await prisma.evalRun.upsert({
      where: { id: run.id },
      update: {
        fileName: run.fileName,
        filePath: run.filePath,
        reportCreatedAt: run.reportCreatedAt,
        mtimeMs: run.mtimeMs,
        passed: run.passed,
        total: run.total,
        passedCount: run.passedCount,
        failedCount: run.failedCount,
        passRate: run.passRate,
        averageScore: run.averageScore,
        durationMs: run.durationMs,
        metadata: run.metadata,
        coverage: run.coverage,
        results: run.results,
      },
      create: run,
    });
    count += 1;
  }
  return count;
}

async function migrateEvalQueue() {
  const queue = await readJson(EVAL_QUEUE_PATH);
  if (!Array.isArray(queue)) return 0;
  let count = 0;
  for (const item of queue) {
    if (!item?.id) continue;
    const data = {
      status: item.status || 'failed',
      cli: 'moagent',
      model: 'local_qwen:qwen3.5-9b-q5km',
      reasoningEffort: '',
      selectedCases: Array.isArray(item.selectedCases) ? item.selectedCases : [],
      limit: typeof item.limit === 'number' ? item.limit : null,
      keepProjects: Boolean(item.keepProjects),
      reportId: item.reportId ?? null,
      reportPath: item.reportPath ?? null,
      logPath: item.logPath ?? null,
      pid: typeof item.pid === 'number' ? item.pid : null,
      exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
      error: item.error ?? null,
      createdAt: toDate(item.createdAt),
      startedAt: item.startedAt ? toDate(item.startedAt) : null,
      finishedAt: item.finishedAt ? toDate(item.finishedAt) : null,
    };
    await prisma.evalQueueItem.upsert({
      where: { id: item.id },
      update: data,
      create: { id: item.id, ...data },
    });
    count += 1;
  }
  return count;
}

async function migrateEvalRepairs() {
  const repairs = await readJson(EVAL_REPAIRS_PATH);
  if (!Array.isArray(repairs)) return 0;
  let count = 0;
  for (const item of repairs) {
    if (!item?.id) continue;
    const data = {
      runId: item.runId || '',
      caseId: item.caseId || '',
      title: item.title || '未命名修复单',
      status: item.status === 'resolved' ? 'resolved' : 'open',
      severity: item.severity === 'high' ? 'high' : 'medium',
      model: item.model || '',
      reportPath: item.reportPath || '',
      projectId: item.projectId ?? null,
      failures: Array.isArray(item.failures) ? item.failures : [],
      validationSummaries: Array.isArray(item.validationSummaries) ? item.validationSummaries : [],
      suggestedActions: Array.isArray(item.suggestedActions) ? item.suggestedActions : [],
      skillVersions: item.skillVersions && typeof item.skillVersions === 'object' ? item.skillVersions : {},
      createdAt: toDate(item.createdAt),
      updatedAt: toDate(item.updatedAt),
    };
    await prisma.evalRepairTicket.upsert({
      where: { id: item.id },
      update: data,
      create: { id: item.id, ...data },
    });
    count += 1;
  }
  return count;
}

async function migrateEvalSchedule() {
  const schedule = await readJson(EVAL_SCHEDULE_PATH);
  if (!schedule || typeof schedule !== 'object') return 0;
  const data = {
    enabled: Boolean(schedule.enabled),
    intervalHours: Number(schedule.intervalHours || 24),
    cli: 'moagent',
    model: 'local_qwen:qwen3.5-9b-q5km',
    reasoningEffort: '',
    selectedCases: Array.isArray(schedule.selectedCases) ? schedule.selectedCases : [],
    limit: typeof schedule.limit === 'number' ? schedule.limit : null,
    keepProjects: Boolean(schedule.keepProjects),
    nextRunAt: schedule.nextRunAt ? toDate(schedule.nextRunAt) : null,
    lastRunAt: schedule.lastRunAt ? toDate(schedule.lastRunAt) : null,
    lastQueuedRunId: schedule.lastQueuedRunId ?? null,
  };
  await prisma.evalSchedule.upsert({
    where: { id: 'default' },
    update: data,
    create: { id: 'default', ...data },
  });
  return 1;
}

async function main() {
  const settings = await migrateSettings();
  const scans = await migrateStrategyScans();
  const evalRuns = await migrateEvalRuns();
  const evalQueue = await migrateEvalQueue();
  const evalRepairs = await migrateEvalRepairs();
  const evalSchedule = await migrateEvalSchedule();
  console.log(`Platform state migration complete: settings=${settings.created} created/${settings.skipped} skipped, scanRuns=${scans.runs}, scanJobs=${scans.jobs}, evalRuns=${evalRuns}, evalQueue=${evalQueue}, evalRepairs=${evalRepairs}, evalSchedule=${evalSchedule}.`);
}

main()
  .catch((error) => {
    console.error('[migrate-platform-state-to-postgres] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
