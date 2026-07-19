export type QuestionMode = 'act' | 'chat';

export const QUESTION_MODE_COPY: Record<QuestionMode, {
  label: string;
  description: string;
  outputLabel: string;
}> = {
  act: {
    label: '生成看板',
    description: '获取真实数据并生成可交付看板',
    outputLabel: '生成交互看板',
  },
  chat: {
    label: '只做问答',
    description: '只回答问题，不修改当前看板',
    outputLabel: '只做分析问答',
  },
};

export const QUESTION_COMPOSER_COPY = {
  defaultPlaceholder: '向 QuantPilot 描述你的量化需求...',
  runningPlaceholder: '补充要求将在当前任务结束后自动执行…',
  modelRewriteTitle: '提交后由所选大模型解析',
  modelRewriteHelper: '输入阶段不做关键词预判',
  literalTarget: '标的原文保真',
  resolverVerification: 'Resolver 校验证券代码',
  advancedSettings: '高级',
  advancedSettingsDescription: '执行引擎与模型设置',
} as const;

const CHAT_ONLY_EXECUTION_CONSTRAINT = "Do not modify code or generate a dashboard. Only answer the user's request with evidence.";

export function buildQuestionInstruction(question: string, mode: QuestionMode): string {
  const visibleQuestion = question.trim();
  return mode === 'chat'
    ? `${visibleQuestion}\n\n${CHAT_ONLY_EXECUTION_CONSTRAINT}`
    : visibleQuestion;
}

export function questionOutputLabel(mode: QuestionMode): string {
  return QUESTION_MODE_COPY[mode].outputLabel;
}

export function buildQuickQuestions(projectName = ''): string[] {
  const exactProjectName = projectName.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const subject = exactProjectName.length >= 2 && exactProjectName.length <= 16 &&
    !/[，,。！？?；;\n]/u.test(exactProjectName)
    ? exactProjectName
    : '当前标的';
  return [
    `分析${subject}近60个交易日的趋势、量能和主要风险`,
    `评估${subject}的财务质量、估值位置和关键风险`,
    `梳理${subject}近期重要公告及其潜在影响`,
    `对${subject}做一个均线策略回测并说明适用边界`,
  ];
}
