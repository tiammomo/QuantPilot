import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  publish: vi.fn(),
  getProjectById: vi.fn(),
  updateProject: vi.fn(),
  createMessage: vi.fn(),
  markUserRequestAsRunning: vi.fn(),
  markUserRequestAsCompleted: vi.fn(),
  markUserRequestAsFailed: vi.fn(),
  isUserRequestCancelled: vi.fn(),
  registerAgentRun: vi.fn(),
  completeAgentRun: vi.fn(),
  failAgentRun: vi.fn(),
  isAgentRunCancelled: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mocks.query,
}));

vi.mock('../stream', () => ({
  streamManager: { publish: mocks.publish },
}));

vi.mock('../project', () => ({
  getProjectById: mocks.getProjectById,
  updateProject: mocks.updateProject,
}));

vi.mock('../message', () => ({
  createMessage: mocks.createMessage,
}));

vi.mock('@/lib/services/claude-skills', () => ({
  buildQuantPilotSystemPrompt: vi.fn(() => 'system prompt'),
  buildQuantPilotTaskPrompt: vi.fn(async (instruction: string) => instruction),
  ensureClaudeSkillsForProject: vi.fn(async () => []),
  readQuantPilotManifest: vi.fn(async () => null),
}));

vi.mock('@/lib/services/quant-image-mcp', () => ({
  buildQuantPilotMcpServers: vi.fn(() => ({})),
}));

vi.mock('@/lib/services/user-requests', () => ({
  markUserRequestAsRunning: mocks.markUserRequestAsRunning,
  // These exports intentionally remain mocked so the ownership regression is
  // explicit: the Agent runtime must never call either terminal writer.
  markUserRequestAsCompleted: mocks.markUserRequestAsCompleted,
  markUserRequestAsFailed: mocks.markUserRequestAsFailed,
  isUserRequestCancelled: mocks.isUserRequestCancelled,
}));

vi.mock('@/lib/services/agent-runtime', () => ({
  registerAgentRun: mocks.registerAgentRun,
  completeAgentRun: mocks.completeAgentRun,
  failAgentRun: mocks.failAgentRun,
  isAgentRunCancelled: mocks.isAgentRunCancelled,
}));

import { executeClaude } from './claude';

type FakeSdkMessage = {
  type: string;
  subtype?: string;
  is_error?: boolean;
  errors?: string[];
};

function sdkResponse(messages: FakeSdkMessage[], terminalError?: Error) {
  return {
    close: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message;
      }
      if (terminalError) {
        throw terminalError;
      }
    },
  };
}

const originalEnvironment = {
  apiKey: process.env.DEEPSEEK_API_KEY,
  projectsDir: process.env.PROJECTS_DIR,
  idleTimeout: process.env.DEEPSEEK_AGENT_IDLE_TIMEOUT_MS,
  executionTimeout: process.env.DEEPSEEK_AGENT_EXECUTION_TIMEOUT_MS,
  artifactInterval: process.env.QUANTPILOT_ARTIFACT_CHECK_INTERVAL_MS,
  artifactStable: process.env.QUANTPILOT_ARTIFACT_STABLE_MS,
};

let projectRoot = '';
let projectPath = '';

function restoreEnvironment(name: keyof typeof originalEnvironment, envName: string) {
  const value = originalEnvironment[name];
  if (value === undefined) {
    delete process.env[envName];
  } else {
    process.env[envName] = value;
  }
}

function statusEvents() {
  return mocks.publish.mock.calls
    .map(([, event]) => event as { type?: string; data?: { status?: string; message?: string } })
    .filter((event) => event.type === 'status');
}

describe('DeepSeek Agent terminal ownership', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-agent-terminal-'));
    projectPath = path.join(projectRoot, 'project-runtime-terminal');
    await fs.mkdir(projectPath, { recursive: true });

    process.env.DEEPSEEK_API_KEY = 'deepseek-test-key';
    process.env.PROJECTS_DIR = projectRoot;
    process.env.DEEPSEEK_AGENT_IDLE_TIMEOUT_MS = '600000';
    process.env.DEEPSEEK_AGENT_EXECUTION_TIMEOUT_MS = '600000';
    process.env.QUANTPILOT_ARTIFACT_CHECK_INTERVAL_MS = '600000';
    process.env.QUANTPILOT_ARTIFACT_STABLE_MS = '600000';

    mocks.getProjectById.mockResolvedValue({
      id: 'project-runtime-terminal',
      name: 'Runtime terminal test',
    });
    mocks.updateProject.mockResolvedValue(undefined);
    mocks.createMessage.mockResolvedValue({});
    mocks.markUserRequestAsRunning.mockResolvedValue(true);
    mocks.markUserRequestAsCompleted.mockResolvedValue(true);
    mocks.markUserRequestAsFailed.mockResolvedValue(true);
    mocks.isUserRequestCancelled.mockResolvedValue(false);
    mocks.isAgentRunCancelled.mockReturnValue(false);
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
    restoreEnvironment('apiKey', 'DEEPSEEK_API_KEY');
    restoreEnvironment('projectsDir', 'PROJECTS_DIR');
    restoreEnvironment('idleTimeout', 'DEEPSEEK_AGENT_IDLE_TIMEOUT_MS');
    restoreEnvironment('executionTimeout', 'DEEPSEEK_AGENT_EXECUTION_TIMEOUT_MS');
    restoreEnvironment('artifactInterval', 'QUANTPILOT_ARTIFACT_CHECK_INTERVAL_MS');
    restoreEnvironment('artifactStable', 'QUANTPILOT_ARTIFACT_STABLE_MS');
  });

  it('publishes only the Agent-stage success terminal and leaves UserRequest open', async () => {
    mocks.query.mockReturnValue(
      sdkResponse([{ type: 'result', subtype: 'success', is_error: false }]),
    );

    await executeClaude(
      'project-runtime-terminal',
      projectPath,
      '生成可视化看板',
      'deepseek-v4-flash',
      undefined,
      'request-agent-success',
    );

    const statuses = statusEvents().map((event) => event.data?.status);
    expect(statuses).toContain('agent_execution_completed');
    expect(statuses).not.toContain('completed');
    expect(statuses).not.toContain('error');
    expect(statuses).not.toContain('agent_execution_failed');
    expect(statuses.filter((status) => status === 'agent_execution_completed')).toHaveLength(1);
    expect(mocks.publish.mock.calls.some(([, event]) => event.type === 'error')).toBe(false);
    expect(mocks.markUserRequestAsRunning).toHaveBeenCalledWith('request-agent-success');
    expect(mocks.markUserRequestAsCompleted).not.toHaveBeenCalled();
    expect(mocks.markUserRequestAsFailed).not.toHaveBeenCalled();
    expect(mocks.completeAgentRun).toHaveBeenCalledWith(
      'project-runtime-terminal',
      'request-agent-success',
    );
  });

  it('publishes only the Agent-stage failure terminal when the SDK throws', async () => {
    mocks.query.mockReturnValue(sdkResponse([], new Error('SDK execution exploded')));

    await expect(
      executeClaude(
        'project-runtime-terminal',
        projectPath,
        '生成可视化看板',
        'deepseek-v4-flash',
        undefined,
        'request-agent-failure',
      ),
    ).rejects.toThrow('SDK execution exploded');

    const terminalEvents = statusEvents().filter((event) =>
      ['agent_execution_completed', 'agent_execution_failed', 'completed', 'error'].includes(
        event.data?.status ?? '',
      ),
    );
    expect(terminalEvents).toEqual([
      expect.objectContaining({
        type: 'status',
        data: expect.objectContaining({
          status: 'agent_execution_failed',
          message: 'SDK execution exploded',
        }),
      }),
    ]);
    expect(mocks.publish.mock.calls.some(([, event]) => event.type === 'error')).toBe(false);
    expect(mocks.markUserRequestAsCompleted).not.toHaveBeenCalled();
    expect(mocks.markUserRequestAsFailed).not.toHaveBeenCalled();
    expect(mocks.failAgentRun).toHaveBeenCalledWith(
      'project-runtime-terminal',
      'request-agent-failure',
    );
  });

  it('treats an SDK error result as Agent-stage failure instead of success', async () => {
    mocks.query.mockReturnValue(
      sdkResponse([
        {
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          errors: ['maximum turns reached'],
        },
      ]),
    );

    await expect(
      executeClaude(
        'project-runtime-terminal',
        projectPath,
        '生成可视化看板',
        'deepseek-v4-flash',
        undefined,
        'request-agent-error-result',
      ),
    ).rejects.toThrow('maximum turns reached');

    const statuses = statusEvents().map((event) => event.data?.status);
    expect(statuses).toContain('agent_execution_failed');
    expect(statuses).not.toContain('agent_execution_completed');
    expect(statuses).not.toContain('completed');
    expect(statuses).not.toContain('error');
    expect(mocks.publish.mock.calls.some(([, event]) => event.type === 'error')).toBe(false);
    expect(mocks.markUserRequestAsCompleted).not.toHaveBeenCalled();
    expect(mocks.markUserRequestAsFailed).not.toHaveBeenCalled();
  });

  it('preserves cancellation without converting it into an Agent failure terminal', async () => {
    mocks.isUserRequestCancelled.mockResolvedValue(true);

    await expect(
      executeClaude(
        'project-runtime-terminal',
        projectPath,
        '生成可视化看板',
        'deepseek-v4-flash',
        undefined,
        'request-agent-cancelled',
      ),
    ).rejects.toThrow('用户暂停了当前任务');

    const statuses = statusEvents().map((event) => event.data?.status);
    expect(statuses).toContain('agent_paused');
    expect(statuses).not.toContain('agent_execution_completed');
    expect(statuses).not.toContain('agent_execution_failed');
    expect(statuses).not.toContain('completed');
    expect(statuses).not.toContain('error');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.publish.mock.calls.some(([, event]) => event.type === 'error')).toBe(false);
    expect(mocks.markUserRequestAsCompleted).not.toHaveBeenCalled();
    expect(mocks.markUserRequestAsFailed).not.toHaveBeenCalled();
  });
});
