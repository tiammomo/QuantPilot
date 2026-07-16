const fs = require('fs');
const path = require('path');

const REQUIRED_SCENARIOS = Object.freeze([
  'standard',
  'custom-no-card',
  'repair',
  'technical',
  'fundamental',
  'portfolio',
  'cancellation-or-crash',
  'security-boundary',
]);

const LIVE_MODEL_SCENARIOS = new Set([
  'custom-no-card',
  'technical',
  'fundamental',
  'portfolio',
]);

const EVIDENCE_CLASSES = new Set([
  'live_model',
  'product_control',
  'contract_and_runtime_test',
  'runtime_test',
]);

const CONTRACT_ONLY_CASE_TYPES = new Set([
  'runtime_registry',
  'repair_plan',
  'source_degradation_contract',
  'renderer_capability_contract',
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(value, label, problems) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    problems.push(`${label} 必须是非空字符串数组。`);
    return [];
  }
  const normalized = value.map((item) => item.trim());
  const duplicates = normalized.filter((item, index) => normalized.indexOf(item) !== index);
  if (duplicates.length > 0) {
    problems.push(`${label} 包含重复项：${Array.from(new Set(duplicates)).join(', ')}`);
  }
  return Array.from(new Set(normalized));
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeRuntimeTestPath(root, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    !relativePath.startsWith('src/') ||
    !/\.test\.[cm]?[jt]sx?$/.test(relativePath) ||
    relativePath.includes('\\')
  ) {
    return null;
  }
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  return stat?.isFile() && !stat.isSymbolicLink() ? absolute : null;
}

function assertScenarioCaseShape(name, testCase, problems) {
  if (!testCase) return;
  if (name === 'standard' && testCase.expectedExecutionLane !== 'deterministic_standard') {
    problems.push(`${testCase.id} 必须声明 expectedExecutionLane=deterministic_standard。`);
  }
  if (LIVE_MODEL_SCENARIOS.has(name) && testCase.expectedExecutionLane !== 'model_custom') {
    problems.push(`${testCase.id} 必须声明 expectedExecutionLane=model_custom。`);
  }
  if (name === 'custom-no-card') {
    if (testCase.expectedNoCardSurface !== true) {
      problems.push(`${testCase.id} 必须声明 expectedNoCardSurface=true。`);
    }
    if (!/(?:不要|去掉|取消|without)\s*(?:卡片|cards?)/iu.test(testCase.question || '')) {
      problems.push(`${testCase.id} 的问题必须显式表达不要卡片式界面。`);
    }
  }
  const expectedCapability = {
    technical: 'technical_analysis',
    fundamental: 'fundamental_analysis',
    portfolio: 'portfolio_risk',
  }[name];
  if (expectedCapability && testCase.capabilityId !== expectedCapability) {
    problems.push(`${testCase.id} 的 capabilityId 必须为 ${expectedCapability}。`);
  }
}

function loadQuantE2eSuite(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const suitePath = path.resolve(root, options.suitePath || 'benchmarks/quantpilot/e2e-suite.json');
  const casesPath = path.resolve(root, options.casesPath || 'benchmarks/quantpilot/cases.json');
  const suite = options.suite || JSON.parse(fs.readFileSync(suitePath, 'utf8'));
  const cases = options.cases || JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const requireReleaseCoverage = options.requireReleaseCoverage === true;
  const problems = [];

  if (!Array.isArray(cases)) {
    throw new Error('benchmarks/quantpilot/cases.json 必须是数组。');
  }
  const caseById = new Map();
  for (const testCase of cases) {
    if (!isRecord(testCase) || typeof testCase.id !== 'string' || !testCase.id.trim()) {
      problems.push('benchmark case 缺少有效 id。');
      continue;
    }
    if (caseById.has(testCase.id)) problems.push(`benchmark case id 重复：${testCase.id}`);
    caseById.set(testCase.id, testCase);
  }

  if (!isRecord(suite)) problems.push('E2E suite 根节点必须是对象。');
  const schemaVersion = Number(suite.schemaVersion || 1);
  if (![1, 2].includes(schemaVersion)) {
    problems.push(`E2E suite schemaVersion 只支持 1 或 2，实际为 ${suite.schemaVersion ?? 'missing'}。`);
  }
  const caseIds = uniqueStrings(suite.caseIds, 'E2E suite caseIds', problems);
  const unknownLiveIds = caseIds.filter((id) => !caseById.has(id));
  if (unknownLiveIds.length > 0) {
    problems.push(`E2E suite 包含未知 live case：${unknownLiveIds.join(', ')}`);
  }
  for (const id of caseIds) {
    const testCase = caseById.get(id);
    if (
      testCase &&
      (CONTRACT_ONLY_CASE_TYPES.has(testCase.type) || testCase.expectClarification === true)
    ) {
      problems.push(`${id} 不能作为 accepted live-model E2E case。`);
    }
  }

  const scenarios = isRecord(suite.scenarios) ? suite.scenarios : {};
  const normalizedScenarios = {};
  const runtimeTestFiles = new Set();
  const productControlCaseIds = new Set();
  const referencedLiveCaseIds = new Set();

  if (schemaVersion === 2 || requireReleaseCoverage) {
    if (schemaVersion !== 2) problems.push('正式发布 E2E suite 必须使用 schemaVersion=2。');
    if (typeof suite.id !== 'string' || !suite.id.trim()) {
      problems.push('schema v2 E2E suite 必须声明稳定 id。');
    }
    for (const scenarioName of REQUIRED_SCENARIOS) {
      const scenario = scenarios[scenarioName];
      if (!isRecord(scenario)) {
        problems.push(`E2E suite 缺少场景 ${scenarioName}。`);
        continue;
      }
      const evidenceClass = scenario.evidenceClass;
      if (!EVIDENCE_CLASSES.has(evidenceClass)) {
        problems.push(`${scenarioName}.evidenceClass 无效：${evidenceClass ?? 'missing'}。`);
      }
      const scenarioCaseIds = uniqueStrings(
        scenario.caseIds || [],
        `${scenarioName}.caseIds`,
        problems,
      );
      const scenarioRuntimeTests = uniqueStrings(
        scenario.runtimeTests || [],
        `${scenarioName}.runtimeTests`,
        problems,
      );
      if (evidenceClass === 'live_model' || evidenceClass === 'product_control') {
        if (scenarioCaseIds.length === 0) {
          problems.push(`${scenarioName} 至少需要一个真实产品 case。`);
        }
      }
      if (evidenceClass === 'runtime_test' || evidenceClass === 'contract_and_runtime_test') {
        if (scenarioRuntimeTests.length === 0) {
          problems.push(`${scenarioName} 至少需要一个 runtime test。`);
        }
      }
      if (scenarioName === 'repair') {
        const hasRepairContract = scenarioCaseIds.some(
          (id) => caseById.get(id)?.type === 'repair_plan',
        );
        if (!hasRepairContract) {
          problems.push('repair 场景必须绑定一个 type=repair_plan 的确定性 contract case。');
        }
      }
      for (const id of scenarioCaseIds) {
        const testCase = caseById.get(id);
        if (!testCase) {
          problems.push(`${scenarioName} 引用了未知 case：${id}`);
          continue;
        }
        assertScenarioCaseShape(scenarioName, testCase, problems);
        if (evidenceClass === 'live_model') {
          referencedLiveCaseIds.add(id);
          if (!caseIds.includes(id)) {
            problems.push(`${scenarioName} live case ${id} 必须进入 suite.caseIds。`);
          }
        }
        if (evidenceClass === 'product_control') {
          productControlCaseIds.add(id);
          if (caseIds.includes(id)) {
            problems.push(`${id} 是零模型 product control，不能混入 DeepSeek live-model caseIds。`);
          }
        }
      }
      for (const relativePath of scenarioRuntimeTests) {
        const absolute = safeRuntimeTestPath(root, relativePath);
        if (!absolute) {
          problems.push(`${scenarioName} runtime test 路径无效或不存在：${relativePath}`);
        } else {
          runtimeTestFiles.add(path.relative(root, absolute).replaceAll(path.sep, '/'));
        }
      }
      normalizedScenarios[scenarioName] = {
        evidenceClass,
        caseIds: scenarioCaseIds,
        runtimeTests: scenarioRuntimeTests,
      };
    }

    const unclassifiedLiveIds = caseIds.filter((id) => !referencedLiveCaseIds.has(id));
    if (unclassifiedLiveIds.length > 0) {
      problems.push(`live-model case 未映射到正式场景：${unclassifiedLiveIds.join(', ')}`);
    }
    const declaredProductControlIds = uniqueStrings(
      suite.productControlCaseIds || [],
      'E2E suite productControlCaseIds',
      problems,
    );
    if (!sameStrings(
      [...declaredProductControlIds].sort(),
      [...productControlCaseIds].sort(),
    )) {
      problems.push('productControlCaseIds 必须与 product_control 场景引用完全一致。');
    }
  }

  if (problems.length > 0) {
    const error = new Error(`MoAgent E2E suite 无效：\n- ${problems.join('\n- ')}`);
    error.problems = problems;
    throw error;
  }

  return {
    schemaVersion,
    id: typeof suite.id === 'string' && suite.id.trim() ? suite.id.trim() : 'legacy-e2e-suite',
    description: typeof suite.description === 'string' ? suite.description : '',
    caseIds,
    productControlCaseIds: [...productControlCaseIds],
    runtimeTestFiles: [...runtimeTestFiles],
    scenarios: normalizedScenarios,
    cases,
    caseById,
    raw: suite,
  };
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validTimeWindow(startedAt, finishedAt) {
  const started = Date.parse(startedAt || '');
  const finished = Date.parse(finishedAt || '');
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started;
}

function attestProductControlEvidence(evidence, options) {
  const problems = [];
  const expectedIds = [...options.suite.productControlCaseIds];
  const results = Array.isArray(evidence?.results) ? evidence.results : [];
  const resultIds = results.map((result) => result?.id).filter(Boolean);
  if (evidence?.schemaVersion !== 1) problems.push('product controls schemaVersion 必须为 1。');
  if (evidence?.suiteId !== options.suite.id) problems.push('product controls suiteId 不匹配。');
  if (evidence?.suiteSchemaVersion !== options.suite.schemaVersion) {
    problems.push('product controls suiteSchemaVersion 不匹配。');
  }
  if (evidence?.frameworkVersion !== options.frameworkVersion) {
    problems.push('product controls frameworkVersion 不匹配。');
  }
  if (evidence?.buildRevision !== options.buildRevision) {
    problems.push('product controls buildRevision 不匹配。');
  }
  if (!options.gitRevision || evidence?.gitRevision !== options.gitRevision) {
    problems.push('product controls gitRevision 不匹配。');
  }
  if (!sameStrings([...resultIds].sort(), [...expectedIds].sort())) {
    problems.push(`product controls case 集不完整：要求 ${expectedIds.join(', ')}，实际 ${resultIds.join(', ') || '(empty)'}。`);
  }
  if (!sameStrings(
    [...(Array.isArray(evidence?.caseIds) ? evidence.caseIds : [])].sort(),
    [...expectedIds].sort(),
  )) {
    problems.push('product controls caseIds 与 suite 不匹配。');
  }
  if (!validTimeWindow(evidence?.startedAt, evidence?.finishedAt)) {
    problems.push('product controls 缺少有效执行时间窗口。');
  }
  if (new Set(resultIds).size !== resultIds.length) problems.push('product controls case ID 重复。');

  for (const [label, values] of [
    ['requestId', results.map((result) => result?.requestId)],
    ['missionId', results.map((result) => result?.agentExecution?.missionId)],
    ['generationId', results.map((result) => result?.agentExecution?.generationId)],
    ['acceptedReceiptId', results.map((result) => result?.agentExecution?.acceptedReceiptId)],
    ['runId', results.flatMap((result) => result?.agentExecution?.runIds || [])],
  ]) {
    const normalized = values.filter(nonEmptyString);
    if (normalized.length !== values.length || new Set(normalized).size !== normalized.length) {
      problems.push(`product controls ${label} 必须完整且跨 case 唯一。`);
    }
  }

  for (const result of results) {
    const caseId = result?.id || 'unknown';
    const execution = result?.agentExecution;
    const acceptance = result?.missionAcceptance;
    const runs = Array.isArray(execution?.runs) ? execution.runs : [];
    const acceptedRun = runs.find((run) => run?.id === execution?.acceptedSourceRunId);
    if (result?.passed !== true || !Array.isArray(result?.failures) || result.failures.length > 0) {
      problems.push(`${caseId} product control 未通过。`);
    }
    if (
      result?.agentExecuted !== true ||
      execution?.executed !== true ||
      execution?.cli !== 'moagent' ||
      execution?.provider !== 'moagent-trusted-renderer' ||
      execution?.model !== 'moagent-deterministic-renderer-v1' ||
      result?.requestId !== execution?.requestId ||
      execution?.turns !== 2 ||
      !validTimeWindow(execution?.startedAt, execution?.completedAt)
    ) {
      problems.push(`${caseId} 没有证明 deterministic_standard MoAgent 执行。`);
    }
    if (
      execution?.frameworkVersion !== options.frameworkVersion ||
      execution?.buildRevision !== options.buildRevision ||
      execution?.gitRevision !== options.gitRevision
    ) {
      problems.push(`${caseId} product control 运行版本不匹配。`);
    }
    if (
      execution?.missionStatus !== 'completed' ||
      execution?.acceptedReceiptType !== 'acceptance' ||
      execution?.acceptedReceiptVerdict !== 'accepted' ||
      execution?.acceptedCandidateSource !== 'moagent_submit_result' ||
      acceptance?.status !== 'completed' ||
      acceptance?.missionId !== execution?.missionId ||
      acceptance?.generationId !== execution?.generationId ||
      acceptance?.acceptedReceiptId !== execution?.acceptedReceiptId ||
      acceptance?.acceptedReceiptHash !== execution?.acceptedReceiptHash ||
      !/^sha256:[a-f0-9]{64}$/.test(execution?.acceptedReceiptHash || '') ||
      acceptance?.acceptedSourceRunId !== execution?.acceptedSourceRunId ||
      acceptance?.acceptedSourceRequestId !== execution?.acceptedSourceRequestId ||
      acceptance?.acceptedCandidateSource !== execution?.acceptedCandidateSource
    ) {
      problems.push(`${caseId} 缺少当前 Mission accepted receipt。`);
    }
    if (
      runs.length !== 1 ||
      !Array.isArray(execution?.runIds) ||
      execution.runIds.length !== 1 ||
      execution.runIds[0] !== acceptedRun?.id ||
      acceptedRun?.status !== 'candidate_complete' ||
      acceptedRun?.provider !== 'moagent-trusted-renderer' ||
      acceptedRun?.model !== 'moagent-deterministic-renderer-v1' ||
      acceptedRun?.requestId !== execution?.acceptedSourceRequestId ||
      acceptedRun?.frameworkVersion !== options.frameworkVersion ||
      acceptedRun?.buildRevision !== options.buildRevision ||
      acceptedRun?.turns !== 2 ||
      !validTimeWindow(acceptedRun?.startedAt, acceptedRun?.completedAt)
    ) {
      problems.push(`${caseId} deterministic candidate lineage 无效。`);
    }
    const usage = execution?.usage;
    if (
      !nonNegativeInteger(usage?.inputTokens) ||
      !nonNegativeInteger(usage?.outputTokens) ||
      !nonNegativeInteger(usage?.totalTokens) ||
      !nonNegativeInteger(usage?.cachedInputTokens) ||
      !nonNegativeInteger(usage?.cacheMissInputTokens) ||
      !nonNegativeInteger(usage?.reasoningTokens) ||
      usage?.inputTokens !== 0 ||
      usage?.outputTokens !== 0 ||
      usage?.totalTokens !== 0 ||
      usage?.cachedInputTokens !== 0 ||
      usage?.cacheMissInputTokens !== 0 ||
      usage?.reasoningTokens !== 0 ||
      acceptedRun?.usage?.inputTokens !== 0 ||
      acceptedRun?.usage?.outputTokens !== 0 ||
      acceptedRun?.usage?.totalTokens !== 0 ||
      acceptedRun?.usage?.cachedInputTokens !== 0 ||
      acceptedRun?.usage?.cacheMissInputTokens !== 0 ||
      acceptedRun?.usage?.reasoningTokens !== 0
    ) {
      problems.push(`${caseId} deterministic standard 必须提供零模型 Token 证明。`);
    }
    const tools = execution?.tools;
    if (
      tools?.total !== 2 ||
      tools?.succeeded !== 2 ||
      tools?.workspaceWriteSucceeded !== 1 ||
      tools?.submitResultSucceeded !== 1 ||
      tools?.unexpectedFailureCount !== 0 ||
      tools?.failed !== 0 ||
      tools?.uncertain !== 0 ||
      !Array.isArray(tools?.succeededToolNames) ||
      !sameStrings(
        [...tools.succeededToolNames].sort(),
        ['apply_dashboard_spec', 'submit_result'],
      )
    ) {
      problems.push(`${caseId} 缺少成功 workspace write/submit_result 或存在工具失败。`);
    }
    if (
      result?.validation?.status !== 'passed' ||
      !Array.isArray(result?.validation?.checks) ||
      result.validation.checks.some((check) => check?.status === 'failed') ||
      (result?.visualCheck != null && result.visualCheck.passed !== true) ||
      (result?.eventAudit != null && result.eventAudit.errorCount !== 0)
    ) {
      problems.push(`${caseId} 产品验证或视觉/事件验收未通过。`);
    }
  }

  const expectedPassed = problems.length === 0;
  if (evidence?.passed !== expectedPassed) {
    problems.push('product controls passed 与逐项重算结果不一致。');
  }
  return { passed: problems.length === 0, problems };
}

module.exports = {
  REQUIRED_SCENARIOS,
  attestProductControlEvidence,
  loadQuantE2eSuite,
};
