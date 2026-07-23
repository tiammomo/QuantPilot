import fs from 'fs/promises';
import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { getRuntimeDegradationConfig } from '@/lib/config/degradation';
import type { StrategyScanJob, StrategyScanRun, StrategyScanRunResult } from './strategy-types';

const ROOT = path.resolve(/*turbopackIgnore: true*/ process.cwd());
const DATA_DIR = process.env.STRATEGY_SCANS_DIR
  ? path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.STRATEGY_SCANS_DIR)
  : path.join(ROOT, 'data', 'strategy-scans');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');

function getDatabaseConfig() {
  return getRuntimeDegradationConfig().components.database;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function toDate(value: string | Date | undefined | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isScanRunStatus(value: string): StrategyScanRun['status'] {
  return value === 'completed' || value === 'failed' || value === 'partial' ? value : 'failed';
}

function isScanJobStatus(value: string): StrategyScanJob['status'] {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed'
    ? value
    : 'failed';
}

function scanRunResults(value: unknown): StrategyScanRunResult[] {
  return Array.isArray(value) ? value as StrategyScanRunResult[] : [];
}

function mapDbScanRun(record: {
  id: string;
  templateId: string;
  scanId: string;
  symbol: string;
  status: string;
  startedAt: Date;
  completedAt: Date;
  total: number;
  succeeded: number;
  failed: number;
  bestResultId: string | null;
  objective: string;
  source: string;
  results: unknown;
}): StrategyScanRun {
  return {
    id: record.id,
    templateId: record.templateId,
    scanId: record.scanId,
    symbol: record.symbol,
    status: isScanRunStatus(record.status),
    startedAt: record.startedAt.toISOString(),
    completedAt: record.completedAt.toISOString(),
    total: record.total,
    succeeded: record.succeeded,
    failed: record.failed,
    bestResultId: record.bestResultId,
    objective: record.objective,
    source: record.source,
    results: scanRunResults(record.results),
  };
}

function mapDbScanJob(record: {
  id: string;
  templateId: string;
  scanId: string;
  symbol: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  runId: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}): StrategyScanJob {
  return {
    id: record.id,
    templateId: record.templateId,
    scanId: record.scanId,
    symbol: record.symbol,
    status: isScanJobStatus(record.status),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    startedAt: record.startedAt ? record.startedAt.toISOString() : undefined,
    completedAt: record.completedAt ? record.completedAt.toISOString() : undefined,
    runId: record.runId,
    error: record.error,
  };
}

async function listScanRunsFromDatabase(): Promise<StrategyScanRun[]> {
  if (!getDatabaseConfig().enabled) return [];
  const records = await prisma.strategyScanRun.findMany({
    orderBy: { completedAt: 'desc' },
  });
  return records.map(mapDbScanRun);
}

async function listScanJobsFromDatabase(): Promise<StrategyScanJob[]> {
  if (!getDatabaseConfig().enabled) return [];
  const records = await prisma.strategyScanJob.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return records.map(mapDbScanJob);
}

async function writeScanRunToDatabase(run: StrategyScanRun) {
  const database = getDatabaseConfig();
  if (!database.enabled) return;
  const startedAt = toDate(run.startedAt) ?? new Date();
  const completedAt = toDate(run.completedAt) ?? new Date();
  const results = run.results as unknown as Prisma.InputJsonValue;
  try {
    await prisma.strategyScanRun.upsert({
      where: { id: run.id },
      update: {
        templateId: run.templateId,
        scanId: run.scanId,
        symbol: run.symbol,
        status: run.status,
        startedAt,
        completedAt,
        total: run.total,
        succeeded: run.succeeded,
        failed: run.failed,
        bestResultId: run.bestResultId ?? null,
        objective: run.objective,
        source: run.source,
        results,
      },
      create: {
        id: run.id,
        templateId: run.templateId,
        scanId: run.scanId,
        symbol: run.symbol,
        status: run.status,
        startedAt,
        completedAt,
        total: run.total,
        succeeded: run.succeeded,
        failed: run.failed,
        bestResultId: run.bestResultId ?? null,
        objective: run.objective,
        source: run.source,
        results,
      },
    });
  } catch (error) {
    if (database.required) throw error;
  }
}

async function writeScanJobToDatabase(job: StrategyScanJob) {
  const database = getDatabaseConfig();
  if (!database.enabled) return;
  try {
    await prisma.strategyScanJob.upsert({
      where: { id: job.id },
      update: {
        templateId: job.templateId,
        scanId: job.scanId,
        symbol: job.symbol,
        status: job.status,
        startedAt: toDate(job.startedAt),
        completedAt: toDate(job.completedAt),
        runId: job.runId ?? null,
        error: job.error ?? null,
        createdAt: toDate(job.createdAt) ?? new Date(),
        updatedAt: toDate(job.updatedAt) ?? new Date(),
      },
      create: {
        id: job.id,
        templateId: job.templateId,
        scanId: job.scanId,
        symbol: job.symbol,
        status: job.status,
        startedAt: toDate(job.startedAt),
        completedAt: toDate(job.completedAt),
        runId: job.runId ?? null,
        error: job.error ?? null,
        createdAt: toDate(job.createdAt) ?? new Date(),
        updatedAt: toDate(job.updatedAt) ?? new Date(),
      },
    });
  } catch (error) {
    if (database.required) throw error;
  }
}

export async function listScanRuns(): Promise<StrategyScanRun[]> {
  const dbRuns = await listScanRunsFromDatabase().catch(() => []);
  try {
    const runEntries = await fs.readdir(RUNS_DIR, { withFileTypes: true }).catch(() => []);
    const runFiles = runEntries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => path.join(RUNS_DIR, entry.name));
    const runs = await Promise.all(runFiles.map(filePath => readJsonFile<StrategyScanRun>(filePath)));
    const byId = new Map<string, StrategyScanRun>();
    for (const run of runs.filter((run): run is StrategyScanRun => Boolean(run?.id && run?.templateId && run?.scanId))) {
      byId.set(run.id, run);
    }
    for (const run of dbRuns) {
      byId.set(run.id, run);
    }
    return Array.from(byId.values()).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  } catch {
    return dbRuns;
  }
}

function scanRunPath(runId: string) {
  return path.join(RUNS_DIR, `${runId}.json`);
}

export async function listScanJobs(): Promise<StrategyScanJob[]> {
  const dbJobs = await listScanJobsFromDatabase().catch(() => []);
  try {
    const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true });
    const jobs = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => readJsonFile<StrategyScanJob>(path.join(JOBS_DIR, entry.name)))
    );
    const byId = new Map<string, StrategyScanJob>();
    for (const job of jobs.filter((job): job is StrategyScanJob => Boolean(job?.id && job?.templateId && job?.scanId))) {
      byId.set(job.id, job);
    }
    for (const job of dbJobs) {
      byId.set(job.id, job);
    }
    return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return dbJobs;
  }
}

function scanJobPath(jobId: string) {
  return path.join(JOBS_DIR, `${jobId}.json`);
}

export async function writeScanJob(job: StrategyScanJob) {
  await Promise.all([
    writeScanJobToDatabase(job),
    writeJsonFile(scanJobPath(job.id), job).catch(() => undefined),
  ]);
}

export async function writeScanRun(run: StrategyScanRun) {
  await Promise.all([
    writeScanRunToDatabase(run),
    writeJsonFile(scanRunPath(run.id), run).catch(() => undefined),
  ]);
}
