import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  MoAgentArtifactRequirement,
  MoAgentEvidenceVerdict,
  MoAgentMissionSpec,
} from './types';

const MAX_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_FILES = 4_096;
const MAX_EVIDENCE_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_PREVIEW_RESPONSE_BYTES = 2 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 15_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RECURSIVE_ARTIFACT_SUFFIX = '/**';
const FORBIDDEN_RECURSIVE_SEGMENTS = new Set([
  '.next',
  'node_modules',
  '.git',
  '.quantpilot',
]);

type JsonRecord = Record<string, unknown>;

export interface MoAgentEvidenceArtifact {
  path: string;
  role: 'subject' | 'evidence';
  bytes: number;
  sha256: string;
}

export interface MoAgentEvidenceArtifactIssue {
  path: string;
  role: 'subject' | 'evidence';
  code:
    | 'REQUIRED_ARTIFACT_MISSING'
    | 'REQUIRED_ARTIFACT_NOT_FILE'
    | 'EVIDENCE_ARTIFACT_TOO_LARGE';
}

export interface MoAgentValidationCheckEvidence {
  id: string;
  status: 'passed' | 'failed' | 'warning';
  summarySha256: string;
}

export interface MoAgentEvidenceDecision {
  verdict: Extract<
    MoAgentEvidenceVerdict,
    'accepted' | 'repair_required' | 'retry_infrastructure' | 'stale' | 'rejected'
  >;
  reasonCodes: string[];
  failedCheckIds: string[];
  candidateVersion: number;
  subjectHash: string;
  payload: {
    schemaVersion: 1;
    missionId: string;
    generationId: string;
    projectId: string;
    requestId: string;
    candidateVersion: number;
    missionSpecSha256: string;
    validation: {
      reportPath: '.quantpilot/validation.json';
      reportSha256: string;
      runId: string | null;
      checks: MoAgentValidationCheckEvidence[];
    };
    artifacts: {
      subjectManifestSha256: string;
      evidenceManifestSha256: string;
      items: MoAgentEvidenceArtifact[];
      evidenceItems: MoAgentEvidenceArtifact[];
      issues: MoAgentEvidenceArtifactIssue[];
    };
    preview: {
      url: string;
      port: number;
      httpStatus: number;
      responseSha256: string;
      readyAt: string;
    };
    decision: {
      verdict: MoAgentEvidenceDecision['verdict'];
      reasonCodes: string[];
      failedCheckIds: string[];
    };
    createdAt: string;
  };
  receiptHash: string;
}

export class MoAgentEvidenceVerificationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MoAgentEvidenceVerificationError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot hash a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new Error(`Cannot hash ${typeof value}.`);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function framedManifestHash(items: readonly MoAgentEvidenceArtifact[]): string {
  return `sha256:${sha256(canonicalJson(items.map((item) => ({
    path: item.path,
    role: item.role,
    bytes: item.bytes,
    sha256: item.sha256,
  }))))}`;
}

function assertHash(value: string, label: string): string {
  const normalized = value.replace(/^sha256:/, '').toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} is not SHA-256.`);
  return `sha256:${normalized}`;
}

function isWorkspaceChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function hasForbiddenRecursiveSegment(relativePath: string): boolean {
  return relativePath.split(path.sep).some((segment) =>
    FORBIDDEN_RECURSIVE_SEGMENTS.has(segment));
}

function assertRecursiveCanonicalPath(
  root: string,
  canonicalPath: string,
  logicalPath: string,
): void {
  if (!isWorkspaceChild(root, canonicalPath)) {
    throw new MoAgentEvidenceVerificationError(
      'ARTIFACT_SYMLINK_ESCAPE',
      `Acceptance-surface artifact resolves outside the workspace: ${logicalPath}`,
    );
  }
  const canonicalRelative = path.relative(root, canonicalPath);
  if (hasForbiddenRecursiveSegment(canonicalRelative)) {
    throw new MoAgentEvidenceVerificationError(
      'ARTIFACT_FORBIDDEN_PATH',
      `Acceptance-surface artifact resolves into an excluded directory: ${logicalPath}`,
    );
  }
}

function wildcardPattern(pattern: string): RegExp {
  const parts = pattern.split('*').map((part) =>
    part.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'));
  return new RegExp(`^${parts.join('[^/]*')}$`);
}

function requirementPriority(requirement: MoAgentArtifactRequirement): number {
  const role = requirement.role === 'subject' ? 3 : requirement.role === 'evidence' ? 2 : 1;
  return role * 2 + (requirement.required ? 1 : 0);
}

function mergeConcreteRequirement(
  target: Map<string, MoAgentArtifactRequirement>,
  requirement: MoAgentArtifactRequirement,
  concretePath = requirement.path,
): void {
  const candidate = { ...requirement, path: concretePath };
  const existing = target.get(concretePath);
  if (!existing) {
    target.set(concretePath, candidate);
    return;
  }
  const winner = requirementPriority(candidate) > requirementPriority(existing)
    ? candidate
    : existing;
  target.set(concretePath, {
    ...winner,
    // A duplicate optional surface must never weaken an exact required artifact.
    required: existing.required || candidate.required,
  });
}

async function canonicalSurfaceEntry(input: {
  root: string;
  absolutePath: string;
  logicalPath: string;
}): Promise<{ canonicalPath: string; stat: Awaited<ReturnType<typeof fs.stat>> }> {
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(input.absolutePath);
  } catch {
    throw new MoAgentEvidenceVerificationError(
      'ARTIFACT_SURFACE_CHANGED',
      `Acceptance-surface artifact disappeared while it was enumerated: ${input.logicalPath}`,
    );
  }
  assertRecursiveCanonicalPath(input.root, canonicalPath, input.logicalPath);
  return { canonicalPath, stat: await fs.stat(canonicalPath) };
}

async function walkRecursiveSurface(input: {
  root: string;
  canonicalDirectory: string;
  logicalDirectory: string;
  requirement: MoAgentArtifactRequirement;
  target: Map<string, MoAgentArtifactRequirement>;
  ancestors: ReadonlySet<string>;
}): Promise<void> {
  const entries = await fs.readdir(input.canonicalDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (FORBIDDEN_RECURSIVE_SEGMENTS.has(entry.name)) continue;
    const logicalPath = `${input.logicalDirectory}/${entry.name}`.replace(/^\//, '');
    const resolved = await canonicalSurfaceEntry({
      root: input.root,
      absolutePath: path.join(input.canonicalDirectory, entry.name),
      logicalPath,
    });
    if (resolved.stat.isFile()) {
      mergeConcreteRequirement(input.target, input.requirement, logicalPath);
      if (input.target.size > MAX_EVIDENCE_FILES) {
        throw new MoAgentEvidenceVerificationError(
          'ARTIFACT_FILE_COUNT_LIMIT_EXCEEDED',
          `Acceptance surface exceeds ${MAX_EVIDENCE_FILES} files.`,
        );
      }
      continue;
    }
    if (resolved.stat.isDirectory()) {
      if (input.ancestors.has(resolved.canonicalPath)) {
        throw new MoAgentEvidenceVerificationError(
          'ARTIFACT_SYMLINK_CYCLE',
          `Acceptance-surface directory contains a symlink cycle: ${logicalPath}`,
        );
      }
      await walkRecursiveSurface({
        ...input,
        canonicalDirectory: resolved.canonicalPath,
        logicalDirectory: logicalPath,
        ancestors: new Set([...input.ancestors, resolved.canonicalPath]),
      });
      continue;
    }
    throw new MoAgentEvidenceVerificationError(
      'ARTIFACT_UNSUPPORTED_FILE_TYPE',
      `Acceptance surface contains a non-regular file: ${logicalPath}`,
    );
  }
}

async function expandArtifactRequirements(
  root: string,
  requirements: readonly MoAgentArtifactRequirement[],
): Promise<MoAgentArtifactRequirement[]> {
  const concrete = new Map<string, MoAgentArtifactRequirement>();
  const ordered = [...requirements].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  let rootEntryNames: string[] | null = null;

  for (const requirement of ordered) {
    if (requirement.role === 'control') continue;
    if (requirement.path.endsWith(RECURSIVE_ARTIFACT_SUFFIX)) {
      const logicalDirectory = requirement.path.slice(0, -RECURSIVE_ARTIFACT_SUFFIX.length);
      const absoluteDirectory = path.resolve(root, logicalDirectory);
      if (!isWorkspaceChild(root, absoluteDirectory)) {
        throw new MoAgentEvidenceVerificationError(
          'ARTIFACT_PATH_ESCAPE',
          `Acceptance surface escapes the workspace: ${requirement.path}`,
        );
      }
      let directoryEntryExists = true;
      try {
        await fs.lstat(absoluteDirectory);
      } catch (error) {
        if (!requirement.required && isRecord(error) && error.code === 'ENOENT') {
          directoryEntryExists = false;
        } else {
          throw error;
        }
      }
      if (!directoryEntryExists) continue;
      let canonicalDirectory: string;
      try {
        canonicalDirectory = await fs.realpath(absoluteDirectory);
      } catch {
        throw new MoAgentEvidenceVerificationError(
          'ARTIFACT_SURFACE_CHANGED',
          `Recursive acceptance surface cannot be resolved: ${requirement.path}`,
        );
      }
      assertRecursiveCanonicalPath(root, canonicalDirectory, requirement.path);
      const stat = await fs.stat(canonicalDirectory);
      if (!stat.isDirectory()) {
        throw new MoAgentEvidenceVerificationError(
          'ARTIFACT_SURFACE_NOT_DIRECTORY',
          `Recursive acceptance surface is not a directory: ${requirement.path}`,
        );
      }
      await walkRecursiveSurface({
        root,
        canonicalDirectory,
        logicalDirectory,
        requirement,
        target: concrete,
        ancestors: new Set([canonicalDirectory]),
      });
      continue;
    }
    if (requirement.path.includes('*')) {
      if (requirement.path.includes('/')) {
        throw new MoAgentEvidenceVerificationError(
          'ARTIFACT_PATTERN_INVALID',
          `Only platform root-file wildcard patterns are supported: ${requirement.path}`,
        );
      }
      rootEntryNames ??= (await fs.readdir(root, { withFileTypes: true }))
        .map((entry) => entry.name)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      const matcher = wildcardPattern(requirement.path);
      for (const entryName of rootEntryNames) {
        if (!matcher.test(entryName)) continue;
        const resolved = await canonicalSurfaceEntry({
          root,
          absolutePath: path.join(root, entryName),
          logicalPath: entryName,
        });
        if (!resolved.stat.isFile()) {
          throw new MoAgentEvidenceVerificationError(
            'ARTIFACT_SURFACE_NOT_FILE',
            `Root configuration acceptance artifact is not a file: ${entryName}`,
          );
        }
        mergeConcreteRequirement(concrete, requirement, entryName);
      }
      continue;
    }
    mergeConcreteRequirement(concrete, requirement);
  }

  if (concrete.size > MAX_EVIDENCE_FILES) {
    throw new MoAgentEvidenceVerificationError(
      'ARTIFACT_FILE_COUNT_LIMIT_EXCEEDED',
      `Acceptance surface exceeds ${MAX_EVIDENCE_FILES} files.`,
    );
  }
  return [...concrete.values()].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function readBoundedWorkspaceFile(
  root: string,
  relativePath: string,
): Promise<{ content: Buffer; bytes: number; sha256: string }> {
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new MoAgentEvidenceVerificationError(
      'ARTIFACT_PATH_ESCAPE',
      `Evidence artifact escapes the workspace: ${relativePath}`,
    );
  }
  const canonical = await fs.realpath(candidate).catch(() => null);
  if (!canonical) {
    throw new MoAgentEvidenceVerificationError(
      'REQUIRED_ARTIFACT_MISSING',
      `Required evidence artifact is missing: ${relativePath}`,
    );
  }
  const canonicalRelative = path.relative(root, canonical);
  if (!canonicalRelative || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
    throw new MoAgentEvidenceVerificationError(
      'ARTIFACT_SYMLINK_ESCAPE',
      `Evidence artifact resolves outside the workspace: ${relativePath}`,
    );
  }
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) {
    throw new MoAgentEvidenceVerificationError(
      'REQUIRED_ARTIFACT_NOT_FILE',
      `Required evidence artifact is not a file: ${relativePath}`,
    );
  }
  if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new MoAgentEvidenceVerificationError(
      'EVIDENCE_ARTIFACT_TOO_LARGE',
      `Evidence artifact exceeds ${MAX_EVIDENCE_FILE_BYTES} bytes: ${relativePath}`,
    );
  }
  const content = await fs.readFile(canonical);
  if (content.byteLength > MAX_EVIDENCE_FILE_BYTES) {
    throw new MoAgentEvidenceVerificationError(
      'EVIDENCE_ARTIFACT_TOO_LARGE',
      `Evidence artifact exceeds ${MAX_EVIDENCE_FILE_BYTES} bytes: ${relativePath}`,
    );
  }
  return { content, bytes: content.byteLength, sha256: `sha256:${sha256(content)}` };
}

async function artifactManifest(
  workspaceRoot: string,
  requirements: readonly MoAgentArtifactRequirement[],
): Promise<{
  subjects: MoAgentEvidenceArtifact[];
  evidence: MoAgentEvidenceArtifact[];
  issues: MoAgentEvidenceArtifactIssue[];
}> {
  const subjects: MoAgentEvidenceArtifact[] = [];
  const evidence: MoAgentEvidenceArtifact[] = [];
  const issues: MoAgentEvidenceArtifactIssue[] = [];
  const concreteRequirements = await expandArtifactRequirements(workspaceRoot, requirements);
  let totalBytes = 0;
  let fileCount = 0;
  for (const requirement of concreteRequirements) {
    if (requirement.role === 'control') continue;
    let file: Awaited<ReturnType<typeof readBoundedWorkspaceFile>>;
    try {
      file = await readBoundedWorkspaceFile(workspaceRoot, requirement.path);
    } catch (error) {
      if (error instanceof MoAgentEvidenceVerificationError &&
        ['REQUIRED_ARTIFACT_MISSING', 'REQUIRED_ARTIFACT_NOT_FILE'].includes(error.code)) {
        if (!requirement.required) continue;
        issues.push({
          path: requirement.path,
          role: requirement.role,
          code: error.code as MoAgentEvidenceArtifactIssue['code'],
        });
        continue;
      }
      throw error;
    }
    fileCount += 1;
    totalBytes += file.bytes;
    if (fileCount > MAX_EVIDENCE_FILES) {
      throw new MoAgentEvidenceVerificationError(
        'ARTIFACT_FILE_COUNT_LIMIT_EXCEEDED',
        `Acceptance surface exceeds ${MAX_EVIDENCE_FILES} files.`,
      );
    }
    if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {
      throw new MoAgentEvidenceVerificationError(
        'ARTIFACT_TOTAL_BYTES_LIMIT_EXCEEDED',
        `Acceptance surface exceeds ${MAX_EVIDENCE_TOTAL_BYTES} bytes.`,
      );
    }
    const item: MoAgentEvidenceArtifact = {
      path: requirement.path,
      role: requirement.role,
      bytes: file.bytes,
      sha256: file.sha256,
    };
    if (requirement.role === 'subject') subjects.push(item);
    else evidence.push(item);
  }
  const comparePath = (left: MoAgentEvidenceArtifact, right: MoAgentEvidenceArtifact) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  subjects.sort(comparePath);
  evidence.sort(comparePath);
  issues.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 :
      left.code < right.code ? -1 : left.code > right.code ? 1 : 0);
  return { subjects, evidence, issues };
}

function validationChecks(value: unknown): MoAgentValidationCheckEvidence[] {
  if (!Array.isArray(value)) {
    throw new MoAgentEvidenceVerificationError(
      'VALIDATION_CHECKS_INVALID',
      'Validation report checks must be an array.',
    );
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' ||
      !['passed', 'failed', 'warning'].includes(String(item.status))) {
      throw new MoAgentEvidenceVerificationError(
        'VALIDATION_CHECK_INVALID',
        'Validation report contains a malformed check.',
      );
    }
    const summary = typeof item.summary === 'string' ? item.summary : '';
    return {
      id: item.id,
      status: item.status as MoAgentValidationCheckEvidence['status'],
      summarySha256: `sha256:${sha256(summary)}`,
    };
  });
}

function classifyValidation(params: {
  spec: MoAgentMissionSpec;
  report: JsonRecord;
  checks: readonly MoAgentValidationCheckEvidence[];
}): {
  verdict: Exclude<MoAgentEvidenceDecision['verdict'], 'accepted' | 'stale'>;
  reasonCodes: string[];
  failedCheckIds: string[];
} | null {
  const counts = new Map<string, number>();
  for (const check of params.checks) counts.set(check.id, (counts.get(check.id) ?? 0) + 1);
  const missing = params.spec.requiredValidationCheckIds.filter((id) => !counts.has(id));
  const duplicate = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  if (missing.length || duplicate.length) {
    return {
      verdict: 'rejected',
      reasonCodes: [
        ...(missing.length ? ['REQUIRED_VALIDATION_CHECK_MISSING'] : []),
        ...(duplicate.length ? ['VALIDATION_CHECK_DUPLICATED'] : []),
      ],
      failedCheckIds: [...missing, ...duplicate].sort(),
    };
  }

  const required = params.checks.filter((check) =>
    params.spec.requiredValidationCheckIds.includes(check.id));
  const anyFailed = params.checks.some((check) => check.status === 'failed');
  const failed = required.filter((check) => check.status === 'failed').map((check) => check.id);
  const warnings = required
    .filter((check) => check.status === 'warning' &&
      !params.spec.allowedValidationWarnings.includes(check.id))
    .map((check) => check.id);
  const reportPassed = params.report.passed === true && params.report.status === 'passed';
  if (reportPassed && anyFailed) {
    return {
      verdict: 'rejected',
      reasonCodes: ['VALIDATION_REPORT_CONTRADICTS_CHECKS'],
      failedCheckIds: params.checks
        .filter((check) => check.status === 'failed')
        .map((check) => check.id)
        .sort(),
    };
  }
  if (!reportPassed && failed.length === 0 && warnings.length === 0) {
    return {
      verdict: 'rejected',
      reasonCodes: ['VALIDATION_REPORT_CONTRADICTS_CHECKS'],
      failedCheckIds: [],
    };
  }
  if (failed.length > 0) {
    return {
      verdict: 'repair_required',
      reasonCodes: ['REQUIRED_VALIDATION_CHECK_FAILED'],
      failedCheckIds: failed.sort(),
    };
  }
  if (warnings.length > 0) {
    const infrastructureWarning = warnings.some((id) =>
      ['visual_presentation', 'preview_http_200', 'next_build'].includes(id));
    return {
      verdict: infrastructureWarning ? 'retry_infrastructure' : 'repair_required',
      reasonCodes: [
        infrastructureWarning
          ? 'REQUIRED_VALIDATION_INFRASTRUCTURE_WARNING'
          : 'REQUIRED_VALIDATION_WARNING',
      ],
      failedCheckIds: warnings.sort(),
    };
  }
  return null;
}

function localPreviewUrl(value: string, expectedPort: number): URL {
  const url = new URL(value);
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (url.protocol !== 'http:' || !localHosts.has(url.hostname)) {
    throw new MoAgentEvidenceVerificationError(
      'PREVIEW_URL_NOT_LOCAL',
      'EvidenceVerifier only accepts the platform-managed local HTTP preview.',
    );
  }
  const port = Number(url.port || 80);
  if (!Number.isSafeInteger(expectedPort) || expectedPort <= 0 || port !== expectedPort) {
    throw new MoAgentEvidenceVerificationError(
      'PREVIEW_PORT_MISMATCH',
      'Preview URL does not match the platform-reported port.',
    );
  }
  return url;
}

async function probePreview(params: {
  url: string;
  port: number;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ status: number; responseSha256: string }> {
  const url = localPreviewUrl(params.url, params.port);
  const timeoutSignal = AbortSignal.timeout(PREVIEW_TIMEOUT_MS);
  const signal = params.signal
    ? AbortSignal.any([params.signal, timeoutSignal])
    : timeoutSignal;
  let response: Response;
  try {
    response = await params.fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    throw new MoAgentEvidenceVerificationError(
      'PREVIEW_HTTP_UNAVAILABLE',
      `Persistent preview HTTP probe failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_PREVIEW_RESPONSE_BYTES) {
    throw new MoAgentEvidenceVerificationError(
      'PREVIEW_RESPONSE_TOO_LARGE',
      'Persistent preview response exceeds the EvidenceVerifier limit.',
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PREVIEW_RESPONSE_BYTES) {
    throw new MoAgentEvidenceVerificationError(
      'PREVIEW_RESPONSE_TOO_LARGE',
      'Persistent preview response exceeds the EvidenceVerifier limit.',
    );
  }
  if (response.status !== 200) {
    throw new MoAgentEvidenceVerificationError(
      'PREVIEW_HTTP_NOT_READY',
      `Persistent preview returned HTTP ${response.status}.`,
    );
  }
  return { status: response.status, responseSha256: `sha256:${sha256(bytes)}` };
}

async function probePreviewWithRetry(
  params: Parameters<typeof probePreview>[0],
): Promise<Awaited<ReturnType<typeof probePreview>>> {
  try {
    return await probePreview(params);
  } catch (error) {
    if (
      !(error instanceof MoAgentEvidenceVerificationError) ||
      !['PREVIEW_HTTP_UNAVAILABLE', 'PREVIEW_HTTP_NOT_READY'].includes(error.code)
    ) {
      throw error;
    }
    // A persistent preview has already passed its manager readiness check.
    // One platform-only retry absorbs the narrow hand-off race without
    // spending another model turn or launching an Agent repair.
    return probePreview(params);
  }
}

export async function verifyMoAgentMissionEvidence(input: {
  missionId: string;
  generationId: string;
  candidateVersion: number;
  missionSpec: MoAgentMissionSpec;
  missionSpecSha256: string;
  workspaceRoot: string;
  preview: { url: string; port: number };
  fetchImpl?: typeof fetch;
  now?: () => Date;
  signal?: AbortSignal;
}): Promise<MoAgentEvidenceDecision> {
  if (!Number.isSafeInteger(input.candidateVersion) || input.candidateVersion <= 0) {
    throw new MoAgentEvidenceVerificationError(
      'CANDIDATE_VERSION_INVALID',
      'EvidenceVerifier requires a positive candidate version.',
    );
  }
  const suppliedMissionSpecHash = assertHash(
    input.missionSpecSha256,
    'missionSpecSha256',
  );
  const actualMissionSpecHash = `sha256:${sha256(canonicalJson(input.missionSpec))}`;
  if (suppliedMissionSpecHash !== actualMissionSpecHash) {
    throw new MoAgentEvidenceVerificationError(
      'MISSION_SPEC_HASH_MISMATCH',
      'EvidenceVerifier received a MissionSpec that does not match its durable hash.',
    );
  }
  const root = await fs.realpath(path.resolve(input.workspaceRoot));
  let reportFile: Awaited<ReturnType<typeof readBoundedWorkspaceFile>>;
  let reportAvailable = true;
  let report: JsonRecord = {};
  let checks: MoAgentValidationCheckEvidence[] = [];
  let reportLoadFailure: ReturnType<typeof classifyValidation> = null;
  try {
    reportFile = await readBoundedWorkspaceFile(root, '.quantpilot/validation.json');
  } catch (error) {
    if (error instanceof MoAgentEvidenceVerificationError &&
      ['REQUIRED_ARTIFACT_MISSING', 'REQUIRED_ARTIFACT_NOT_FILE', 'EVIDENCE_ARTIFACT_TOO_LARGE']
        .includes(error.code)) {
      reportAvailable = false;
      reportFile = {
        content: Buffer.alloc(0),
        bytes: 0,
        sha256: `sha256:${sha256('validation-report-unavailable')}`,
      };
      reportLoadFailure = {
        verdict: 'retry_infrastructure',
        reasonCodes: ['VALIDATION_REPORT_UNAVAILABLE'],
        failedCheckIds: [],
      };
    } else {
      throw error;
    }
  }
  if (!reportLoadFailure) {
    try {
      const parsed = JSON.parse(reportFile.content.toString('utf8')) as unknown;
      if (!isRecord(parsed)) throw new Error('not an object');
      report = parsed;
      checks = validationChecks(report.checks);
    } catch (error) {
      reportLoadFailure = {
        verdict: 'rejected',
        reasonCodes: [
          error instanceof MoAgentEvidenceVerificationError
            ? error.code
            : 'VALIDATION_REPORT_INVALID_JSON',
        ],
        failedCheckIds: [],
      };
    }
  }
  const reportRunId = typeof report.runId === 'string' ? report.runId : null;
  const reportProjectId = typeof report.projectId === 'string' ? report.projectId : null;
  const validationFailure = reportLoadFailure ??
    classifyValidation({ spec: input.missionSpec, report, checks });
  const runMismatch = !reportLoadFailure &&
    reportRunId !== input.missionSpec.requestId;
  const projectMismatch = !reportLoadFailure &&
    reportProjectId !== input.missionSpec.projectId;
  const firstManifest = await artifactManifest(root, input.missionSpec.artifacts);
  const firstSubjectHash = framedManifestHash(firstManifest.subjects);
  const firstEvidenceHash = framedManifestHash(firstManifest.evidence);
  const firstIssuesHash = sha256(canonicalJson(firstManifest.issues));
  const now = input.now ?? (() => new Date());

  let previewEvidence = {
    status: 0,
    responseSha256: `sha256:${sha256('not-probed')}`,
  };
  let previewError: MoAgentEvidenceVerificationError | null = null;
  if (!validationFailure && !runMismatch && !projectMismatch &&
    firstManifest.issues.length === 0) {
    try {
      previewEvidence = await probePreviewWithRetry({
        ...input.preview,
        fetchImpl: input.fetchImpl ?? fetch,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      previewError = error instanceof MoAgentEvidenceVerificationError
        ? error
        : new MoAgentEvidenceVerificationError(
            'PREVIEW_HTTP_UNAVAILABLE',
            'Persistent preview HTTP probe failed.',
          );
    }
  }

  let authoritativeReportFile: Awaited<ReturnType<typeof readBoundedWorkspaceFile>>;
  let authoritativeReportAvailable = true;
  try {
    authoritativeReportFile = await readBoundedWorkspaceFile(
      root,
      '.quantpilot/validation.json',
    );
  } catch (error) {
    if (error instanceof MoAgentEvidenceVerificationError &&
      ['REQUIRED_ARTIFACT_MISSING', 'REQUIRED_ARTIFACT_NOT_FILE'].includes(error.code)) {
      authoritativeReportAvailable = false;
      authoritativeReportFile = {
        content: Buffer.alloc(0),
        bytes: 0,
        sha256: `sha256:${sha256('validation-report-unavailable')}`,
      };
    } else {
      throw error;
    }
  }
  let authoritativeReportRunId = reportRunId;
  let authoritativeChecks = checks;
  let validationReportChanged = reportAvailable !== authoritativeReportAvailable ||
    reportFile.sha256 !== authoritativeReportFile.sha256;
  if (validationReportChanged) {
    authoritativeReportRunId = null;
    authoritativeChecks = [];
    if (authoritativeReportAvailable) {
      try {
        const parsed = JSON.parse(authoritativeReportFile.content.toString('utf8')) as unknown;
        if (isRecord(parsed)) {
          authoritativeReportRunId = typeof parsed.runId === 'string' ? parsed.runId : null;
          authoritativeChecks = validationChecks(parsed.checks);
        }
      } catch {
        // The explicit stale verdict below is authoritative even when the
        // replacement report is malformed; never reuse first-read evidence.
      }
    }
  }

  const secondManifest = await artifactManifest(root, input.missionSpec.artifacts);
  const secondSubjectHash = framedManifestHash(secondManifest.subjects);
  const secondEvidenceHash = framedManifestHash(secondManifest.evidence);
  const manifestedValidation = secondManifest.evidence.find((artifact) =>
    artifact.path === '.quantpilot/validation.json');
  if (
    Boolean(manifestedValidation) !== authoritativeReportAvailable ||
    (manifestedValidation && manifestedValidation.sha256 !== authoritativeReportFile.sha256)
  ) {
    validationReportChanged = true;
  }
  const subjectChanged = firstSubjectHash !== secondSubjectHash;
  const evidenceChanged = firstEvidenceHash !== secondEvidenceHash;
  const artifactIssuesChanged = firstIssuesHash !==
    sha256(canonicalJson(secondManifest.issues));
  const artifactReasonCodes = [
    ...(secondManifest.issues.some((issue) => issue.role === 'subject')
      ? ['REQUIRED_SUBJECT_ARTIFACT_UNAVAILABLE']
      : []),
    ...(secondManifest.issues.some((issue) => issue.role === 'evidence')
      ? ['REQUIRED_DERIVED_EVIDENCE_UNAVAILABLE']
      : []),
  ];
  let verdict: MoAgentEvidenceDecision['verdict'] = 'accepted';
  let reasonCodes: string[] = [];
  let failedCheckIds: string[] = [];
  if (projectMismatch) {
    verdict = 'stale';
    reasonCodes = ['VALIDATION_PROJECT_ID_MISMATCH'];
  } else if (runMismatch) {
    verdict = 'stale';
    reasonCodes = ['VALIDATION_RUN_ID_MISMATCH'];
  } else if (subjectChanged || (artifactIssuesChanged &&
    secondManifest.issues.some((issue) => issue.role === 'subject'))) {
    verdict = 'stale';
    reasonCodes = ['SUBJECT_MANIFEST_CHANGED_DURING_VERIFICATION'];
  } else if (validationReportChanged) {
    verdict = 'stale';
    reasonCodes = ['VALIDATION_REPORT_CHANGED_DURING_VERIFICATION'];
  } else if (evidenceChanged || artifactIssuesChanged) {
    verdict = 'stale';
    reasonCodes = ['EVIDENCE_MANIFEST_CHANGED_DURING_VERIFICATION'];
  } else if (validationFailure) {
    verdict = validationFailure.verdict;
    reasonCodes = [...new Set([
      ...validationFailure.reasonCodes,
      ...artifactReasonCodes,
    ])];
    failedCheckIds = validationFailure.failedCheckIds;
  } else if (secondManifest.issues.length > 0) {
    verdict = 'repair_required';
    reasonCodes = artifactReasonCodes;
  } else if (previewError) {
    verdict = 'retry_infrastructure';
    reasonCodes = [previewError.code];
  }

  const createdAt = now().toISOString();
  const payload: MoAgentEvidenceDecision['payload'] = {
    schemaVersion: 1,
    missionId: input.missionId,
    generationId: input.generationId,
    projectId: input.missionSpec.projectId,
    requestId: input.missionSpec.requestId,
    candidateVersion: input.candidateVersion,
    missionSpecSha256: suppliedMissionSpecHash,
    validation: {
      reportPath: '.quantpilot/validation.json',
      reportSha256: authoritativeReportFile.sha256,
      runId: authoritativeReportRunId,
      checks: authoritativeChecks,
    },
    artifacts: {
      subjectManifestSha256: secondSubjectHash,
      evidenceManifestSha256: secondEvidenceHash,
      items: secondManifest.subjects,
      evidenceItems: secondManifest.evidence,
      issues: secondManifest.issues,
    },
    preview: {
      url: input.preview.url,
      port: input.preview.port,
      httpStatus: previewEvidence.status,
      responseSha256: previewEvidence.responseSha256,
      readyAt: createdAt,
    },
    decision: { verdict, reasonCodes, failedCheckIds },
    createdAt,
  };
  return {
    verdict,
    reasonCodes,
    failedCheckIds,
    candidateVersion: input.candidateVersion,
    subjectHash: secondSubjectHash,
    payload,
    receiptHash: `sha256:${sha256(canonicalJson(payload))}`,
  };
}
