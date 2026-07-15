import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  engineOptions: vi.fn(),
  publish: vi.fn(),
  getProjectById: vi.fn(),
  createMessage: vi.fn(),
  getRecentMessages: vi.fn(),
  markRunning: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
  isRequestCancelled: vi.fn(),
  registerRun: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  isRunCancelled: vi.fn(),
  createTools: vi.fn(),
  compileSkills: vi.fn(),
  assessPreparedArtifacts: vi.fn(),
  buildUserPrompt: vi.fn(),
  readRunPlan: vi.fn(),
  readValidationReport: vi.fn(),
  repairWritableGlobs: vi.fn(),
  assertSchemaReady: vi.fn(),
  durableRecord: vi.fn(),
  durableInterrupt: vi.fn(),
  durableClose: vi.fn(),
  createDurableSession: vi.fn(),
  auditRecovery: vi.fn(),
}));

vi.mock('@/lib/agent/core', () => ({
  MoAgentRunEngine: class {
    constructor(options: unknown) {
      mocks.engineOptions(options);
    }
    run = mocks.run;
  },
}));

vi.mock('@/lib/agent/providers/deepseek', () => ({
  DeepSeekProvider: class { readonly name = 'deepseek'; },
  DeepSeekProviderError: class extends Error {},
}));

vi.mock('@/lib/agent/skills', () => ({
  compileMoAgentSkills: mocks.compileSkills,
}));

vi.mock('@/lib/agent/tools', () => ({
  createMoAgentTools: mocks.createTools,
}));

vi.mock('@/lib/services/moagent-prompts', () => ({
  buildQuantPilotSystemPrompt: vi.fn(() => 'system prompt'),
  buildQuantPilotTaskPrompt: vi.fn(async (instruction: string) => instruction),
  buildQuantPilotUserPrompt: mocks.buildUserPrompt,
  assessPlatformPreparedQuantArtifacts: mocks.assessPreparedArtifacts,
}));

vi.mock('@/lib/services/moagent-provenance', () => ({
  hashMoAgentProvenance: vi.fn(() => 'a'.repeat(64)),
  hashMoAgentWorkspace: vi.fn(async () => ({
    sha256: 'b'.repeat(64),
    fileCount: 1,
    hashedBytes: 1,
    metadataOnlyFiles: 0,
  })),
  hashMoAgentWorkspaceIdentity: vi.fn(async () => `sha256:${'c'.repeat(64)}`),
}));

vi.mock('@/lib/services/moagent-run-store', () => ({
  createPrismaMoAgentDurableRunSession: mocks.createDurableSession,
}));

vi.mock('@/lib/services/moagent-recovery', () => ({
  auditPrismaMoAgentRecovery: mocks.auditRecovery,
}));

vi.mock('@/lib/quant/workspace', () => ({
  readQuantRunPlan: mocks.readRunPlan,
}));

vi.mock('@/lib/quant/validation', () => ({
  readQuantValidationReport: mocks.readValidationReport,
  quantValidationRepairWritableGlobs: mocks.repairWritableGlobs,
}));

vi.mock('@/lib/db/moagent-schema-readiness', () => ({
  MOAGENT_SCHEMA_CONTRACT_VERSION: 'test-schema-contract',
  assertMoAgentSchemaReady: mocks.assertSchemaReady,
}));

vi.mock('./moagent-workspace', () => ({
  validateMoAgentProjectPath: vi.fn(async (projectPath: string) => projectPath),
}));

vi.mock('@/lib/services/stream', () => ({
  streamManager: { publish: mocks.publish },
}));

vi.mock('@/lib/services/project', () => ({
  getProjectById: mocks.getProjectById,
}));

vi.mock('@/lib/services/message', () => ({
  createMessage: mocks.createMessage,
  getRecentChatMessagesByProjectId: mocks.getRecentMessages,
}));

vi.mock('@/lib/serializers/chat', () => ({
  createRealtimeMessage: vi.fn((value) => value),
  serializeMessage: vi.fn((value) => value),
}));

vi.mock('@/lib/services/user-requests', () => ({
  markUserRequestAsRunning: mocks.markRunning,
  markUserRequestAsCompleted: mocks.markCompleted,
  markUserRequestAsFailed: mocks.markFailed,
  isUserRequestCancelled: mocks.isRequestCancelled,
}));

vi.mock('@/lib/services/agent-runtime', () => ({
  registerAgentRun: mocks.registerRun,
  completeAgentRun: mocks.completeRun,
  failAgentRun: mocks.failRun,
  isAgentRunCancelled: mocks.isRunCancelled,
}));

import { applyRepairChanges, executeMoAgent } from './moagent';

let workspace = '';

function result(status: string, error?: string) {
  return {
    runId: 'run-test',
    status,
    messages: [],
    output: '',
    turns: 1,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    startedAt: 1,
    finishedAt: 2,
    ...(error ? { error: { code: 'TEST', message: error } } : {}),
  };
}

function statusEvents() {
  return mocks.publish.mock.calls
    .map(([, event]) => event as { type?: string; data?: { status?: string; message?: string } })
    .filter((event) => event.type === 'status');
}

describe('MoAgent terminal ownership', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-terminal-'));
    process.env.DEEPSEEK_API_KEY = 'test-key';
    mocks.getProjectById.mockResolvedValue({ id: 'project-test', repoPath: workspace });
    mocks.getRecentMessages.mockResolvedValue([]);
    mocks.createMessage.mockResolvedValue({});
    mocks.markRunning.mockResolvedValue(true);
    mocks.isRequestCancelled.mockResolvedValue(false);
    mocks.isRunCancelled.mockReturnValue(false);
    mocks.durableRecord.mockResolvedValue(undefined);
    mocks.durableInterrupt.mockResolvedValue(undefined);
    mocks.durableClose.mockResolvedValue(undefined);
    mocks.createTools.mockReturnValue([{ name: 'submit_result', terminal: true }]);
    mocks.assessPreparedArtifacts.mockResolvedValue({
      ready: false,
      reasons: ['platform artifacts are not ready'],
    });
    mocks.buildUserPrompt.mockImplementation(({
      taskPacket,
      skillContext,
      initialDashboardContract,
    }: {
      taskPacket: string;
      skillContext: string;
      initialDashboardContract: string | null;
    }) => [
      taskPacket,
      skillContext ? `skill_context：${skillContext}` : null,
      initialDashboardContract
        ? `initial_dashboard_contract：${initialDashboardContract}`
        : 'initial_dashboard_contract：不可用。请先调用 inspect_dashboard_contract 一次。',
    ].filter(Boolean).join('\n\n'));
    mocks.readRunPlan.mockResolvedValue(null);
    mocks.readValidationReport.mockResolvedValue({
      status: 'failed',
      checks: [{ id: 'visual_presentation', status: 'failed' }],
    });
    mocks.repairWritableGlobs.mockReturnValue(['app/**']);
    mocks.assertSchemaReady.mockResolvedValue({ ready: true, issues: [] });
    mocks.compileSkills.mockResolvedValue({
      systemContext: 'verified skill context',
      taskContext: 'verified task skill context',
      resolvedSkillIds: ['run-planner'],
      skills: [],
    });
    mocks.createDurableSession.mockResolvedValue({
      record: mocks.durableRecord,
      interrupt: mocks.durableInterrupt,
      close: mocks.durableClose,
      failure: null,
      run: { status: 'running' },
    });
    mocks.auditRecovery.mockResolvedValue({
      interruptedRunIds: [],
      blocked: [],
      racedRunIds: [],
    });
    delete process.env.MOAGENT_TIMEOUT_MS;
    delete process.env.MOAGENT_REASONING_EFFORT;
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('publishes only candidate_complete and leaves business completion to Mission acceptance', async () => {
    mocks.run.mockResolvedValue(result('completed'));

    await executeMoAgent(
      'project-test',
      workspace,
      '生成量化看板',
      'deepseek-v4-flash',
      'request-success',
    );

    const statuses = statusEvents().map((event) => event.data?.status);
    expect(statuses.filter((status) => status === 'agent_candidate_complete')).toHaveLength(1);
    expect(statuses).not.toContain('completed');
    expect(statuses).not.toContain('agent_execution_failed');
    expect(mocks.markRunning).toHaveBeenCalledWith('project-test', 'request-success');
    expect(mocks.markCompleted).not.toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.completeRun).toHaveBeenCalledWith('project-test', 'request-success');
  });

  it('publishes a single agent-stage failure for a failed run', async () => {
    mocks.run.mockResolvedValue(result('failed', 'provider exploded'));

    await expect(executeMoAgent(
      'project-test',
      workspace,
      '生成量化看板',
      'deepseek-v4-flash',
      'request-failed',
    )).rejects.toThrow('provider exploded');

    expect(statusEvents().filter((event) => event.data?.status === 'agent_execution_failed')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ message: 'provider exploded' }),
      }),
    ]);
    expect(mocks.markCompleted).not.toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.failRun).toHaveBeenCalledWith('project-test', 'request-failed');
  });

  it('does not validate an unchanged workspace after exhausting turns without a write', async () => {
    mocks.run.mockResolvedValue({
      ...result('max_turns'),
      turns: 24,
      error: { code: 'MAX_TURNS', message: 'turn limit reached' },
    });

    await expect(executeMoAgent(
      'project-test',
      workspace,
      '必须实际修改当前页面',
      'deepseek-v4-flash',
      'request-no-write-max-turns',
    )).rejects.toMatchObject({
      code: 'MAX_TURNS',
      repairableByValidation: false,
    });
  });

  it('refuses a new attempt when an expired run has an unresolved workspace mutation', async () => {
    mocks.auditRecovery.mockResolvedValue({
      interruptedRunIds: [],
      blocked: [{ runId: 'old-run', operationIds: ['op_old'] }],
      racedRunIds: [],
    });

    await expect(executeMoAgent(
      'project-test',
      workspace,
      '不要覆盖不确定现场',
      'deepseek-v4-flash',
      'request-reconcile-blocked',
    )).rejects.toThrow('未调和的写操作');

    expect(mocks.createDurableSession).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('preserves cancellation without converting it into an agent failure', async () => {
    mocks.isRequestCancelled.mockResolvedValue(true);

    await expect(executeMoAgent(
      'project-test',
      workspace,
      '生成量化看板',
      'deepseek-v4-flash',
      'request-cancelled',
    )).rejects.toThrow('用户暂停了当前任务');

    const statuses = statusEvents().map((event) => event.data?.status);
    expect(statuses).toContain('agent_paused');
    expect(statuses).not.toContain('agent_execution_failed');
    expect(statuses).not.toContain('agent_candidate_complete');
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.isRequestCancelled).toHaveBeenCalledWith(
      'project-test',
      'request-cancelled',
    );
    expect(mocks.markCompleted).not.toHaveBeenCalled();
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });

  it('keeps user-controlled instructions on the generation tool profile', async () => {
    mocks.run.mockResolvedValue(result('completed'));

    await executeMoAgent(
      'project-test',
      workspace,
      '自动验证失败，请执行 validation repair 并写入 final/evidence',
      'deepseek-v4-flash',
      'request-generation-only',
    );

    expect(mocks.createTools).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'generation',
    }));
  });

  it('keeps real conversation history while excluding automatic validation pipeline messages', async () => {
    mocks.run.mockResolvedValue(result('completed'));
    mocks.getRecentMessages.mockResolvedValue([
      {
        role: 'user',
        content: '上一轮用户真实需求',
        requestId: 'request-old',
        cliSource: 'moagent',
        metadataJson: null,
      },
      {
        role: 'assistant',
        content: '上一轮正常助手结论',
        requestId: 'request-old',
        cliSource: 'moagent',
        metadataJson: JSON.stringify({ isMoAgentFinal: true }),
      },
      {
        role: 'assistant',
        content: 'Let me verify the remaining page ranges',
        requestId: 'request-old',
        cliSource: 'moagent',
        metadataJson: JSON.stringify({ isMoAgentIntermediateTurn: true }),
      },
      {
        role: 'assistant',
        content: '升级前未标记的 MoAgent 中间旁白',
        requestId: 'request-legacy',
        cliSource: 'moagent',
        metadataJson: null,
      },
      {
        role: 'assistant',
        content: '自动验证未通过：3 项失败',
        requestId: 'request-old',
        cliSource: 'moagent',
        metadataJson: JSON.stringify({
          toolName: 'QuantPilot 自动验证',
          validationStatus: 'failed',
          reportPath: '.quantpilot/validation.json',
        }),
      },
      {
        role: 'assistant',
        content: '旧自动修复助手输出',
        requestId: 'request-old-validation-repair-2',
        cliSource: 'moagent',
        metadataJson: null,
      },
      {
        role: 'assistant',
        content: '验证器直接输出',
        requestId: 'manual-validation',
        cliSource: 'validator',
        metadataJson: null,
      },
      {
        role: 'assistant',
        content: '平台流水线状态',
        requestId: 'request-old',
        cliSource: 'moagent',
        metadataJson: JSON.stringify({ isQuantPilotPipelineStep: true }),
      },
      {
        role: 'user',
        content: '用户消息即使 ID 碰巧带 repair 后缀也要保留',
        requestId: 'user-validation-repair',
        cliSource: 'moagent',
        metadataJson: null,
      },
      {
        role: 'user',
        content: '本轮数据库中的原始输入副本',
        requestId: 'request-current',
        cliSource: 'moagent',
        metadataJson: null,
      },
    ]);

    await executeMoAgent(
      'project-test',
      workspace,
      '本轮任务',
      'deepseek-v4-flash',
      'request-current',
    );

    expect(mocks.getRecentMessages).toHaveBeenCalledWith('project-test', 30);
    const runInput = mocks.run.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
    expect(runInput.messages.filter((message) => message.role !== 'system')).toEqual([
      { role: 'user', content: '上一轮用户真实需求' },
      { role: 'assistant', content: '上一轮正常助手结论' },
      { role: 'user', content: '用户消息即使 ID 碰巧带 repair 后缀也要保留' },
      {
        role: 'user',
        content: [
          '本轮任务',
          'skill_context：verified task skill context',
          'initial_dashboard_contract：不可用。请先调用 inspect_dashboard_contract 一次。',
        ].join('\n\n'),
      },
    ]);
  });

  it('gives a repair run the parent user semantics without replaying validation summaries', async () => {
    mocks.run.mockResolvedValue(result('completed'));
    mocks.getRecentMessages.mockResolvedValue([
      {
        role: 'user',
        content: '请分析大位科技并生成诊断看板',
        requestId: 'request-parent',
        cliSource: 'moagent',
        metadataJson: null,
      },
      {
        role: 'assistant',
        content: '自动验证失败摘要',
        requestId: 'request-parent',
        cliSource: 'moagent',
        metadataJson: JSON.stringify({
          validationStatus: 'failed',
          reportPath: '.quantpilot/validation.json',
        }),
      },
      {
        role: 'assistant',
        content: '第一次自动修复的旧回复',
        requestId: 'request-parent-validation-repair',
        cliSource: 'moagent',
        metadataJson: null,
      },
    ]);

    await applyRepairChanges(
      'project-test',
      workspace,
      '只修复当前 validation report 中的失败项',
      'deepseek-v4-flash',
      'request-parent-validation-repair-2',
      'request-parent',
    );

    const runInput = mocks.run.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> };
    expect(runInput.messages.filter((message) => message.role !== 'system')).toEqual([
      { role: 'user', content: '请分析大位科技并生成诊断看板' },
      {
        role: 'user',
        content: [
          '只修复当前 validation report 中的失败项',
          'skill_context：verified task skill context',
          'initial_dashboard_contract：不可用。请先调用 inspect_dashboard_contract 一次。',
        ].join('\n\n'),
      },
    ]);
  });

  it('selects only the quant capability skills and never appends the platform-only UI skill', async () => {
    mocks.run.mockResolvedValue(result('completed'));
    mocks.readRunPlan.mockResolvedValue({ requestedCapabilityId: 'asset_comparison' });

    await executeMoAgent(
      'project-test',
      workspace,
      '生成多标的对比',
      'deepseek-v4-flash',
      'request-capability-skills',
    );

    expect(mocks.compileSkills).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: 'asset_comparison',
      phase: 'data-preparation',
      hasAttachments: false,
      hasResolvedSymbols: false,
      templateId: expect.any(String),
      variantId: expect.any(String),
      availableToolNames: ['submit_result'],
      maxSystemContextChars: expect.any(Number),
    }));
    expect(mocks.compileSkills.mock.calls[0]?.[0]).not.toHaveProperty('additionalSkillIds');
  });

  it('uses the default quant capability instead of loading every stable skill without a run plan', async () => {
    mocks.run.mockResolvedValue(result('completed'));

    await executeMoAgent(
      'project-test',
      workspace,
      '生成默认个股诊断',
      'deepseek-v4-flash',
      'request-default-skills',
    );

    expect(mocks.compileSkills).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: 'stock_diagnosis',
    }));
    expect(mocks.compileSkills.mock.calls[0]?.[0]).not.toHaveProperty('additionalSkillIds');
  });

  it('uses the compact targeted profile when platform artifacts are already prepared', async () => {
    mocks.run.mockResolvedValue(result('completed'));
    mocks.assessPreparedArtifacts.mockResolvedValue({ ready: true, reasons: [] });
    const runPlan = {
      status: 'planned',
      requestedCapabilityId: 'stock_diagnosis',
    };
    mocks.readRunPlan.mockResolvedValue(runPlan);

    await executeMoAgent(
      'project-test',
      workspace,
      '只重构现有看板视觉',
      'deepseek-v4-flash',
      'request-prepared-profile',
    );

    expect(mocks.assessPreparedArtifacts).toHaveBeenCalledWith(workspace, runPlan);
    expect(mocks.compileSkills).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: 'stock_diagnosis',
      requiredSkillIds: ['dashboard-visualization'],
      phase: 'workspace-generation',
      hasAttachments: false,
      hasResolvedSymbols: false,
      templateId: expect.any(String),
      variantId: expect.any(String),
      availableToolNames: ['submit_result'],
      maxSystemContextChars: expect.any(Number),
    }));
    expect(mocks.createTools).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'generation',
      includeImageExtraction: false,
      includeQuantApi: false,
      targetedReadsOnly: true,
      maxOutputChars: 6_000,
    }));
    expect(mocks.engineOptions).toHaveBeenCalledWith(expect.objectContaining({
      maxTurns: 12,
      maxTotalToolCalls: 20,
      maxRunInputTokens: 160_000,
      maxRunCacheMissInputTokens: 120_000,
      preWriteReadOnlyTurnThreshold: 3,
      postWriteReadOnlyTurnThreshold: 2,
      requireTerminalTool: true,
      requireWorkspaceWriteBeforeTerminal: true,
    }));
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: { enabled: true, effort: 'medium' },
      metadata: expect.objectContaining({
        skillPhase: 'workspace-generation',
      }),
    }), expect.any(Object));
  });

  it('keeps a planned run in data preparation when semantic artifacts are incomplete', async () => {
    mocks.run.mockResolvedValue(result('completed'));
    const runPlan = {
      status: 'planned',
      requestedCapabilityId: 'stock_diagnosis',
      symbols: [{ symbol: '600519', market: 'CN' }],
    };
    mocks.readRunPlan.mockResolvedValue(runPlan);
    mocks.assessPreparedArtifacts.mockResolvedValue({
      ready: false,
      reasons: ['final data has no usable market payload'],
    });

    await executeMoAgent(
      'project-test',
      workspace,
      '基于平台计划生成个股诊断',
      'deepseek-v4-flash',
      'request-semantically-unprepared',
    );

    expect(mocks.compileSkills).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: 'stock_diagnosis',
      phase: 'data-preparation',
      hasResolvedSymbols: true,
    }));
    expect(mocks.compileSkills.mock.calls[0]?.[0]).not.toHaveProperty('requiredSkillIds');
    expect(mocks.createTools).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'generation',
      includeQuantApi: true,
      targetedReadsOnly: false,
    }));
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: { enabled: true, effort: 'high' },
      metadata: expect.objectContaining({ skillPhase: 'data-preparation' }),
    }), expect.any(Object));
  });

  it('uses the repair profile only through the trusted repair entry point', async () => {
    mocks.run.mockResolvedValue(result('completed'));

    await applyRepairChanges(
      'project-test',
      workspace,
      'repair the validation findings',
      'deepseek-v4-flash',
      'request-repair-child',
      'request-parent',
    );

    expect(mocks.createTools).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'repair',
      profileAllowedWriteGlobs: [],
      includeDefaultWriteGlobs: true,
    }));
    expect(mocks.compileSkills).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'validation-repair',
      requiredSkillIds: ['dashboard-visualization'],
    }));
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: { enabled: true, effort: 'high' },
      metadata: expect.objectContaining({ skillPhase: 'validation-repair' }),
    }), expect.any(Object));
    expect(mocks.registerRun).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-test',
      requestId: 'request-parent',
    }));
    expect(mocks.completeRun).toHaveBeenCalledWith('project-test', 'request-parent');
  });

  it('removes source writes and dashboard context from a data-only repair', async () => {
    mocks.run.mockResolvedValue(result('completed'));
    mocks.readValidationReport.mockResolvedValue({
      status: 'failed',
      checks: [{ id: 'final_data_file', status: 'failed' }],
    });
    mocks.repairWritableGlobs.mockReturnValue(['data_file/final/**']);

    await applyRepairChanges(
      'project-test',
      workspace,
      'repair final data only',
      'deepseek-v4-flash',
      'request-data-repair-child',
      'request-parent',
    );

    expect(mocks.createTools).toHaveBeenCalledWith(expect.objectContaining({
      profile: 'repair',
      profileAllowedWriteGlobs: ['data_file/final/**'],
      includeDefaultWriteGlobs: false,
    }));
    expect(mocks.compileSkills).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'validation-repair',
      requiredSkillIds: ['data-quality'],
    }));
    expect(mocks.buildUserPrompt).toHaveBeenCalledWith(expect.objectContaining({
      initialDashboardContract: null,
      requireDashboardContract: false,
    }));
  });

  it('fails closed before tool or provider setup when repair has no failed report', async () => {
    mocks.readValidationReport.mockResolvedValue(null);

    await expect(applyRepairChanges(
      'project-test',
      workspace,
      'repair the validation findings',
      'deepseek-v4-flash',
      'request-repair-missing-report',
      'request-parent',
    )).rejects.toThrow('缺少当前平台失败报告');

    expect(mocks.createTools).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('fails closed when the platform marks the repair report stale', async () => {
    mocks.readValidationReport.mockResolvedValue({
      status: 'failed',
      checks: [
        { id: 'visual_presentation', status: 'failed' },
        { id: 'validation_report_stale', status: 'warning' },
      ],
    });

    await expect(applyRepairChanges(
      'project-test',
      workspace,
      'repair stale findings',
      'deepseek-v4-flash',
      'request-stale-repair-child',
      'request-parent',
    )).rejects.toThrow('缺少当前平台失败报告');

    expect(mocks.createTools).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('fails closed when the request cannot be claimed as running', async () => {
    mocks.markRunning.mockResolvedValue(false);

    await expect(executeMoAgent(
      'project-test',
      workspace,
      '生成量化看板',
      'deepseek-v4-flash',
      'request-not-runnable',
    )).rejects.toThrow('已不处于可运行状态');

    expect(mocks.run).not.toHaveBeenCalled();
    expect(statusEvents().map((event) => event.data?.status)).toContain('agent_execution_failed');
    expect(mocks.failRun).toHaveBeenCalledWith('project-test', 'request-not-runnable');
  });

  it('rechecks cancellation after claiming and before contacting the provider', async () => {
    mocks.isRequestCancelled
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(executeMoAgent(
      'project-test',
      workspace,
      '生成量化看板',
      'deepseek-v4-flash',
      'request-raced-cancel',
    )).rejects.toThrow('用户暂停了当前任务');

    const statuses = statusEvents().map((event) => event.data?.status);
    expect(statuses).toContain('agent_paused');
    expect(statuses).not.toContain('agent_execution_failed');
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('propagates a scoped parent pause into an active repair child run', async () => {
    let cancelRepair: ((reason: string) => void) | undefined;
    mocks.registerRun.mockImplementation((run: { cancel: (reason: string) => void }) => {
      cancelRepair = run.cancel;
    });
    mocks.markRunning.mockImplementation(async () => {
      cancelRepair?.('父请求已暂停');
      return true;
    });

    await expect(applyRepairChanges(
      'project-test',
      workspace,
      'repair the validation findings',
      'deepseek-v4-flash',
      'request-repair-child',
      'request-parent',
    )).rejects.toThrow('父请求已暂停');

    const statuses = statusEvents().map((event) => event.data?.status);
    expect(mocks.registerRun).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-parent',
    }));
    expect(statuses).toContain('agent_paused');
    expect(statuses).not.toContain('agent_execution_failed');
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.failRun).toHaveBeenCalledWith('project-test', 'request-parent');
  });

  it('applies the total deadline to setup before the provider is contacted', async () => {
    process.env.MOAGENT_TIMEOUT_MS = '20';
    mocks.compileSkills.mockImplementationOnce(() => new Promise(() => undefined));

    await expect(executeMoAgent(
      'project-test',
      workspace,
      '生成量化看板',
      'deepseek-v4-flash',
      'request-setup-timeout',
    )).rejects.toThrow('MoAgent 执行超时');

    expect(mocks.run).not.toHaveBeenCalled();
    expect(statusEvents().map((event) => event.data?.status)).toContain('agent_execution_failed');
    expect(statusEvents().map((event) => event.data?.status)).not.toContain('agent_paused');
  });
});
