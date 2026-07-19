#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { chromium, type APIRequestContext, type BrowserContext } from 'playwright';

interface TaskCase {
  id: string;
  capabilityId: string;
  model: string;
  question: string;
}

interface TaskDataset {
  schemaVersion: number;
  id: string;
  description: string;
  cases: TaskCase[];
}

interface ApiResult {
  status: number;
  body: unknown;
}

type JsonRecord = Record<string, unknown>;

interface TerminalSnapshot {
  requestId: string | null;
  status: string;
  terminal: boolean;
  validationStatus: string;
  validationMatchesCurrentRun: boolean;
  missionAcceptanceRequired: boolean;
  missionAcceptanceSatisfied: boolean;
  acceptedReceiptId: string | null;
  previewStatus: string;
  previewUrl: string | null;
  previewPort: number | null;
  persistedPreviewUrl: string | null;
  errorMessage: string | null;
}

interface CaseResult {
  id: string;
  projectId: string;
  requestId: string;
  model: string;
  capabilityId: string;
  question: string;
  state: 'accepted' | 'ready' | 'failed';
  passed: boolean;
  created: boolean;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number;
  missionId: string | null;
  generationId: string | null;
  terminal: TerminalSnapshot | null;
  artifactChecks: Record<string, boolean>;
  previewHttpStatus: number | null;
  failures: string[];
}

const argv = process.argv.slice(2);
const root = process.cwd();
const baseUrl = (process.env.QUANTPILOT_TASK_E2E_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/u, '');
const projectRoot = path.resolve(root, process.env.PROJECTS_DIR || './data/projects');

function option(name: string): string | null {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim() || null;
}

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function integerOption(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(option(name) ?? String(fallback), 10);
  assert(Number.isSafeInteger(value) && value >= min && value <= max,
    `--${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function optionalIntegerOption(name: string, min: number, max: number): number | null {
  const raw = option(name);
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  assert(Number.isSafeInteger(value) && value >= min && value <= max,
    `--${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function campaignId(): string {
  const value = (option('campaign') ?? new Date().toISOString().slice(0, 10).replaceAll('-', '')).toLowerCase();
  assert(/^[a-z0-9][a-z0-9-]{0,23}$/u.test(value),
    '--campaign must contain 1-24 lowercase letters, digits, or hyphens.');
  return value;
}

function taskProjectId(campaign: string, caseId: string): string {
  return `project-e2e-${campaign}-${caseId.toLowerCase()}`;
}

function taskRequestId(campaign: string, caseId: string): string {
  return `task-e2e-${campaign}-${caseId.toLowerCase()}`;
}

function taskTitle(campaign: string, item: TaskCase): string {
  const prefix = `[E2E ${campaign.toUpperCase()}/${item.id}] `;
  const available = Math.max(1, 120 - prefix.length);
  return `${prefix}${item.question.slice(0, available)}`;
}

async function readDataset(): Promise<TaskDataset> {
  const target = path.join(root, 'config', 'evals', 'task-e2e-v1.json');
  const dataset = JSON.parse(await fs.readFile(target, 'utf8')) as TaskDataset;
  assert(dataset.schemaVersion === 1, 'Unsupported task E2E dataset schema.');
  assert(dataset.cases.length === 30, `Task E2E dataset must contain exactly 30 cases, got ${dataset.cases.length}.`);
  assert(new Set(dataset.cases.map((item) => item.id)).size === 30, 'Task E2E case IDs are not unique.');
  return dataset;
}

async function api(
  request: APIRequestContext,
  pathname: string,
  init: { method?: string; data?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const method = (init.method ?? 'GET').toUpperCase();
  const attempts = method === 'GET' ? 3 : 1;
  const retryableStatuses = new Set([408, 425, 429, 502, 503, 504]);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request.fetch(`${baseUrl}${pathname}`, {
        method,
        ...(init.data === undefined ? {} : { data: init.data }),
        headers: {
          Accept: 'application/json',
          Origin: baseUrl,
          ...(init.data === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init.headers ?? {}),
        },
        timeout: 60_000,
      });
      const status = response.status();
      if (attempt < attempts && retryableStatuses.has(status)) {
        await response.dispose();
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
        continue;
      }
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return { status, body };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('QuantPilot API request failed.');
}

async function authenticate(context: BrowserContext): Promise<void> {
  const login = process.env.QUANTPILOT_TASK_E2E_ADMIN_LOGIN?.trim() || 'admin';
  const password = process.env.QUANTPILOT_TASK_E2E_ADMIN_PASSWORD?.trim() || 'admin';
  const target = new URL(baseUrl);
  if ((login === 'admin' || password === 'admin') && !['localhost', '127.0.0.1', '::1'].includes(target.hostname)) {
    throw new Error('Default local E2E credentials are forbidden for a non-loopback QuantPilot URL.');
  }
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (new URL(page.url()).pathname === '/login') {
      await page.getByLabel('账号或邮箱').fill(login);
      await page.getByLabel('密码').fill(password);
      await page.getByRole('button', { name: '登录' }).click();
      await page.waitForURL((url) => url.pathname !== '/login', { timeout: 20_000 });
    }
    const projects = await api(context.request, '/api/projects');
    assert(projects.status === 200, `Authenticated project list returned HTTP ${projects.status}.`);
  } finally {
    await page.close();
  }
}

function terminalSnapshot(value: unknown): TerminalSnapshot {
  const data = record(record(value).data);
  return {
    requestId: stringValue(data.requestId),
    status: stringValue(data.status) ?? 'unknown',
    terminal: booleanValue(data.terminal),
    validationStatus: stringValue(data.validationStatus) ?? 'pending',
    validationMatchesCurrentRun: booleanValue(data.validationMatchesCurrentRun),
    missionAcceptanceRequired: booleanValue(data.missionAcceptanceRequired),
    missionAcceptanceSatisfied: booleanValue(data.missionAcceptanceSatisfied),
    acceptedReceiptId: stringValue(data.acceptedReceiptId),
    previewStatus: stringValue(data.previewStatus) ?? 'unknown',
    previewUrl: stringValue(data.previewUrl),
    previewPort: typeof data.previewPort === 'number' ? data.previewPort : null,
    persistedPreviewUrl: stringValue(data.persistedPreviewUrl),
    errorMessage: stringValue(data.errorMessage),
  };
}

async function generationStatus(request: APIRequestContext, projectId: string): Promise<TerminalSnapshot> {
  const response = await api(request, `/api/projects/${encodeURIComponent(projectId)}/generation/status`);
  assert(response.status === 200, `Generation status for ${projectId} returned HTTP ${response.status}.`);
  return terminalSnapshot(response.body);
}

async function fileJson(filePath: string): Promise<JsonRecord | null> {
  try {
    return record(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch {
    return null;
  }
}

async function artifactEvidence(projectId: string, requestId: string): Promise<{
  checks: Record<string, boolean>;
  failures: string[];
}> {
  const workspace = path.join(projectRoot, projectId);
  const generation = await fileJson(path.join(workspace, '.quantpilot', 'generation-state.json'));
  const validation = await fileJson(path.join(workspace, '.quantpilot', 'validation.json'));
  const dashboard = await fileJson(path.join(workspace, 'data_file', 'final', 'dashboard-data.json'));
  const sources = await fileJson(path.join(workspace, 'evidence', 'sources.json'));
  const pageStat = await fs.stat(path.join(workspace, 'app', 'page.tsx')).catch(() => null);
  const checks = {
    generationState: generation?.requestId === requestId && generation?.status === 'completed',
    validation: validation?.runId === requestId && (validation?.passed === true || validation?.status === 'passed'),
    dashboardData: Boolean(dashboard && Object.keys(dashboard).length > 0),
    sources: Boolean(sources && Object.keys(sources).length > 0),
    dashboardPage: Boolean(pageStat?.isFile() && pageStat.size > 100),
  };
  return {
    checks,
    failures: Object.entries(checks).flatMap(([key, passed]) => passed ? [] : [`Artifact check failed: ${key}`]),
  };
}

async function validateReadyCase(
  request: APIRequestContext,
  projectId: string,
  requestId: string,
  snapshot: TerminalSnapshot,
): Promise<{ checks: Record<string, boolean>; failures: string[]; previewHttpStatus: number | null }> {
  const failures: string[] = [];
  if (snapshot.status !== 'ready') failures.push(`Terminal status is ${snapshot.status}, expected ready.`);
  if (snapshot.requestId !== requestId) failures.push(`Terminal requestId is ${snapshot.requestId ?? 'null'}, expected ${requestId}.`);
  if (snapshot.validationStatus !== 'passed' || !snapshot.validationMatchesCurrentRun) {
    failures.push('Validation did not pass for the current generation run.');
  }
  if (snapshot.missionAcceptanceRequired && (!snapshot.missionAcceptanceSatisfied || !snapshot.acceptedReceiptId)) {
    failures.push('Mission acceptance receipt is missing or does not satisfy the current run.');
  }
  if (snapshot.previewStatus !== 'running' || !snapshot.previewUrl) failures.push('Persistent preview is not running.');
  let previewHttpStatus: number | null = null;
  if (snapshot.previewUrl) {
    const response = await request.get(snapshot.previewUrl, { timeout: 30_000 }).catch(() => null);
    previewHttpStatus = response?.status() ?? null;
    if (!response?.ok()) failures.push(`Preview returned HTTP ${previewHttpStatus ?? 'network-error'}.`);
  }
  const artifacts = await artifactEvidence(projectId, requestId);
  failures.push(...artifacts.failures);
  return { checks: artifacts.checks, failures, previewHttpStatus };
}

async function createOrResumeCase(input: {
  item: TaskCase;
  campaign: string;
  request: APIRequestContext;
  timeoutMs: number;
  pollMs: number;
  retryFailedAttempt: number | null;
  knownProjects: Set<string>;
  onAccepted: (result: CaseResult) => Promise<void>;
}): Promise<CaseResult> {
  const { item, campaign, request } = input;
  const projectId = taskProjectId(campaign, item.id);
  const baseRequestId = taskRequestId(campaign, item.id);
  let requestId = baseRequestId;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let created = false;
  let missionId: string | null = null;
  let generationId: string | null = null;

  if (!input.knownProjects.has(projectId)) {
    const createdProject = await api(request, '/api/projects', {
      method: 'POST',
      headers: { 'Idempotency-Key': `task-e2e-project-${campaign}-${item.id.toLowerCase()}` },
      data: {
        project_id: projectId,
        name: taskTitle(campaign, item),
        initialPrompt: item.question,
        preferredCli: 'moagent',
        selectedModel: item.model,
        quantCapabilityId: item.capabilityId,
        // Every dataset row is an explicit capability selection. Mark it as
        // manual so LLM query rewrite may refine the task but cannot silently
        // replace the user's selected product capability.
        quantCapabilitySource: 'manual',
      },
    });
    assert(createdProject.status === 201,
      `Create ${projectId} returned HTTP ${createdProject.status}: ${JSON.stringify(createdProject.body)}`);
    input.knownProjects.add(projectId);
    created = true;
  }

  let snapshot = await generationStatus(request, projectId);
  if (snapshot.status === 'ready' && snapshot.requestId) {
    requestId = snapshot.requestId;
  }
  const retryFailed = snapshot.terminal &&
    snapshot.status !== 'ready' &&
    input.retryFailedAttempt !== null;
  if (retryFailed) {
    requestId = `${baseRequestId}-r${input.retryFailedAttempt}`;
    assert(snapshot.requestId !== requestId,
      `${projectId} already ended on retry request ${requestId}; choose a higher --retry-failed attempt.`);
  }
  if (snapshot.status === 'idle' || retryFailed) {
    const accepted = await api(request, `/api/chat/${encodeURIComponent(projectId)}/act`, {
      method: 'POST',
      data: {
        instruction: item.question,
        displayInstruction: item.question,
        requestId,
        images: [],
        isInitialPrompt: snapshot.status === 'idle',
        cliPreference: 'moagent',
        selectedModel: item.model,
        quantCapabilityId: item.capabilityId,
        quantCapabilitySource: 'manual',
      },
    });
    const acceptedBody = record(accepted.body);
    assert(accepted.status === 200 && acceptedBody.success === true,
      `Act ${projectId} returned HTTP ${accepted.status}: ${JSON.stringify(accepted.body)}`);
    missionId = stringValue(acceptedBody.missionId);
    generationId = stringValue(acceptedBody.generationId);
    await input.onAccepted({
      id: item.id,
      projectId,
      requestId,
      model: item.model,
      capabilityId: item.capabilityId,
      question: item.question,
      state: 'accepted',
      passed: false,
      created,
      startedAt,
      completedAt: null,
      elapsedMs: Math.round(performance.now() - started),
      missionId,
      generationId,
      terminal: null,
      artifactChecks: {},
      previewHttpStatus: null,
      failures: [],
    });
    snapshot = await generationStatus(request, projectId);
  }

  const deadline = Date.now() + input.timeoutMs;
  while (!snapshot.terminal && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, input.pollMs));
    snapshot = await generationStatus(request, projectId);
  }
  const failures: string[] = [];
  let artifactChecks: Record<string, boolean> = {};
  let previewHttpStatus: number | null = null;
  if (!snapshot.terminal) {
    failures.push(`Task did not reach a terminal state within ${input.timeoutMs}ms; latest=${snapshot.status}.`);
  } else if (snapshot.status === 'ready') {
    const validation = await validateReadyCase(request, projectId, requestId, snapshot);
    artifactChecks = validation.checks;
    failures.push(...validation.failures);
    previewHttpStatus = validation.previewHttpStatus;
  } else {
    failures.push(`Task ended with ${snapshot.status}: ${snapshot.errorMessage ?? 'no error detail'}.`);
  }
  return {
    id: item.id,
    projectId,
    requestId,
    model: item.model,
    capabilityId: item.capabilityId,
    question: item.question,
    state: failures.length === 0 ? 'ready' : 'failed',
    passed: failures.length === 0,
    created,
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - started),
    missionId,
    generationId,
    terminal: snapshot,
    artifactChecks,
    previewHttpStatus,
    failures,
  };
}

async function verifyTaskDrawer(context: BrowserContext, campaign: string, expected: number): Promise<number> {
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('button', { name: /^项目/u }).first().click();
    const search = page.getByLabel('搜索任务记录');
    await search.waitFor({ state: 'visible', timeout: 10_000 });
    await search.fill(`[E2E ${campaign.toUpperCase()}/`);
    const rows = page.locator('.task-drawer-row');
    await rows.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    const count = await rows.count();
    assert(count === expected, `Task drawer exposes ${count} campaign projects, expected ${expected}.`);
    return count;
  } finally {
    await page.close();
  }
}

async function cleanupCampaignProjects(
  request: APIRequestContext,
  campaign: string,
  projectIds: string[],
): Promise<number> {
  const prefix = `project-e2e-${campaign}-`;
  assert(projectIds.every((projectId) => projectId.startsWith(prefix)),
    `Refusing to clean a project outside campaign prefix ${prefix}.`);
  let deleted = 0;
  for (const projectId of projectIds) {
    const response = await api(request, `/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    });
    assert(response.status === 200 || response.status === 404,
      `Delete ${projectId} returned HTTP ${response.status}: ${JSON.stringify(response.body)}`);
    if (response.status === 200) deleted += 1;
  }
  return deleted;
}

async function main(): Promise<void> {
  const dataset = await readDataset();
  const campaign = campaignId();
  const limit = integerOption('limit', 30, 1, 30);
  const concurrency = integerOption('concurrency', 2, 1, 4);
  const timeoutMs = integerOption('timeout-ms',
    Number.parseInt(process.env.QUANTPILOT_TASK_E2E_TIMEOUT_MS ?? '1200000', 10),
    60_000,
    3_600_000,
  );
  const pollMs = integerOption('poll-ms', 5_000, 1_000, 30_000);
  const retryFailedAttempt = optionalIntegerOption('retry-failed', 2, 99);
  const forceCleanup = flag('cleanup');
  const retainProjects = flag('retain-projects');
  assert(!(forceCleanup && retainProjects), '--cleanup and --retain-projects cannot be used together.');
  const only = new Set((option('only') ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  const selected = dataset.cases
    .filter((item) => only.size === 0 || only.has(item.id))
    .slice(0, limit);
  assert(selected.length > 0, 'No task E2E cases were selected.');
  const reportPath = path.join(root, 'tmp', `task-e2e-${campaign}-latest.json`);
  const results = new Map<string, CaseResult>();
  const writeReport = async (
    drawerCount: number | null = null,
    cleanup: { attempted: boolean; deleted: number } | null = null,
  ) => {
    const ordered = selected.flatMap((item) => {
      const result = results.get(item.id);
      return result ? [result] : [];
    });
    const passed = ordered.filter((item) => item.passed).length;
    const report = {
      schemaVersion: 1,
      datasetId: dataset.id,
      campaign,
      checkedAt: new Date().toISOString(),
      baseUrl,
      summary: {
        selected: selected.length,
        recorded: ordered.length,
        accepted: ordered.filter((item) => item.state === 'accepted').length,
        ready: passed,
        failed: ordered.filter((item) => item.state === 'failed').length,
        passRate: ordered.length === selected.length ? passed / selected.length : null,
        taskDrawerCount: drawerCount,
        cleanup,
      },
      results: ordered,
    };
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    const temporary = `${reportPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, reportPath);
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    await authenticate(context);
    const listed = await api(context.request, '/api/projects');
    const knownProjects = new Set(
      (Array.isArray(record(listed.body).data) ? record(listed.body).data as unknown[] : [])
        .map((value) => stringValue(record(value).id))
        .filter((value): value is string => Boolean(value)),
    );
    let next = 0;
    const worker = async () => {
      while (true) {
        const index = next;
        next += 1;
        const item = selected[index];
        if (!item) return;
        try {
          const result = await createOrResumeCase({
            item,
            campaign,
            request: context.request,
            timeoutMs,
            pollMs,
            retryFailedAttempt,
            knownProjects,
            onAccepted: async (accepted) => {
              results.set(item.id, accepted);
              await writeReport();
              process.stderr.write(`[task-e2e] ${item.id} ACCEPTED ${accepted.projectId}\n`);
            },
          });
          results.set(item.id, result);
          await writeReport();
          process.stderr.write(`[task-e2e] ${item.id} ${result.passed ? 'READY' : 'FAIL'} ${Math.round(result.elapsedMs / 1000)}s\n`);
        } catch (error) {
          const failed: CaseResult = {
            id: item.id,
            projectId: taskProjectId(campaign, item.id),
            requestId: taskRequestId(campaign, item.id),
            model: item.model,
            capabilityId: item.capabilityId,
            question: item.question,
            state: 'failed',
            passed: false,
            created: false,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            elapsedMs: 0,
            missionId: null,
            generationId: null,
            terminal: null,
            artifactChecks: {},
            previewHttpStatus: null,
            failures: [error instanceof Error ? error.message : String(error)],
          };
          results.set(item.id, failed);
          await writeReport();
          process.stderr.write(`[task-e2e] ${item.id} FAIL ${failed.failures[0]}\n`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));
    const campaignProjectCount = [...knownProjects]
      .filter((projectId) => projectId.startsWith(`project-e2e-${campaign}-`))
      .length;
    const drawerCount = await verifyTaskDrawer(context, campaign, campaignProjectCount);
    await writeReport(drawerCount);
    const ordered = selected.map((item) => results.get(item.id)!);
    const passed = ordered.filter((item) => item.passed).length;
    const completedFullCampaign = only.size === 0 && selected.length === dataset.cases.length &&
      passed === ordered.length;
    const shouldCleanup = !retainProjects && (forceCleanup || completedFullCampaign);
    const cleanup = shouldCleanup
      ? {
          attempted: true,
          deleted: await cleanupCampaignProjects(
            context.request,
            campaign,
            ordered.map((item) => item.projectId),
          ),
        }
      : { attempted: false, deleted: 0 };
    await writeReport(drawerCount, cleanup);
    process.stdout.write(`${JSON.stringify({
      campaign,
      total: ordered.length,
      passed,
      failed: ordered.length - passed,
      passRate: passed / ordered.length,
      taskDrawerCount: drawerCount,
      cleanup,
      reportPath,
    }, null, 2)}\n`);
    if (passed !== ordered.length) process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
