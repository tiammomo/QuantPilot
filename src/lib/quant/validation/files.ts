import fs from 'fs/promises';
import path from 'path';
import {
  type QuantValidationCheck,
  VALIDATION_REPAIR_PLAN_RELATIVE_PATH,
  VALIDATION_REPORT_RELATIVE_PATH,
} from './contracts';

export function validationReportPath(projectPath: string) {
  return path.join(projectPath, VALIDATION_REPORT_RELATIVE_PATH);
}

export function validationRepairPlanPath(projectPath: string) {
  return path.join(projectPath, VALIDATION_REPAIR_PLAN_RELATIVE_PATH);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function formatDuration(ms?: number): string {
  if (!ms) return '';
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

export function isNonEmptyJsonValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return value !== null && value !== undefined && value !== '';
}

export function normalizeRelativePath(projectPath: string, filePath: string): string {
  return path.relative(projectPath, filePath).replaceAll(path.sep, '/');
}

export async function safeRunCheck(
  id: string,
  name: string,
  checker: () => Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>>
): Promise<QuantValidationCheck> {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Date.now() - startedAt);
  try {
    const result = await checker();
    return {
      id,
      name,
      durationMs: elapsed(),
      ...result,
    };
  } catch (error) {
    return {
      id,
      name,
      status: 'failed',
      summary: `${name}检查异常。`,
      details: error instanceof Error ? error.message : String(error),
      durationMs: elapsed(),
    };
  }
}
