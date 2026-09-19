import type { QuantGenerationTerminalSnapshot } from '@/lib/quant/generation-terminal';

export type QuantValidationState = 'unknown' | 'running' | 'passed' | 'failed';
export type QuantValidationRepairPlan = {
  status: 'needed';
  repairPlanPath?: string;
  steps?: Array<{ checkId?: string; checkName?: string; summary?: string; actions?: string[] }>;
};

export type GenerationPreviewState = {
  previewUrl: string | null;
  isStartingPreview: boolean;
  previewInitializationMessage: string;
  quantValidationState: QuantValidationState;
  quantValidationMessage: string | null;
  quantRepairPlan: QuantValidationRepairPlan | null;
  isRunning: boolean;
  agentWorkComplete: boolean;
  activeStep: NonNullable<QuantGenerationTerminalSnapshot['activeStep']> | null;
};

export const INITIAL_PREVIEW_STATE: GenerationPreviewState = {
  previewUrl: null,
  isStartingPreview: false,
  previewInitializationMessage: '正在启动预览服务...',
  quantValidationState: 'unknown',
  quantValidationMessage: null,
  quantRepairPlan: null,
  isRunning: false,
  agentWorkComplete: false,
  activeStep: null,
};

type StatusUpdate = {
  patch: Partial<GenerationPreviewState>;
  invalidate?: boolean;
  terminalFailure?: boolean;
  reconcile?: boolean;
  reveal?: boolean;
};

// Realtime events describe progress. Only generation/status may accept a preview URL.
export function generationStatusUpdate(
  status: string,
  message?: string,
  metadata?: Record<string, unknown>
): StatusUpdate | null {
  switch (status) {
    case 'validation_running':
      return {
        patch: {
          activeStep: 'validation',
          isRunning: true,
          quantValidationState: 'running',
          quantRepairPlan: null,
          quantValidationMessage: message ?? '正在执行自动验证。',
          previewInitializationMessage: message ?? '正在执行自动验证，验证通过后展示看板。',
        },
      };
    case 'agent_execution_completed':
    case 'agent_execution_failed': {
      const failed = status === 'agent_execution_failed';
      return {
        patch: {
          isRunning: true,
          agentWorkComplete: false,
          activeStep: 'validation',
          quantValidationState: 'running',
          quantValidationMessage: failed
            ? 'Agent 执行异常结束，正在验证已生成产物并尝试自动修复。'
            : 'Agent 代码执行完成，正在进行自动验证。',
          previewInitializationMessage: failed
            ? 'Agent 执行异常，正在验证现有看板产物...'
            : '代码生成完成，正在验证并准备最终看板...',
        },
      };
    }
    case 'validation_repairing':
    case 'validation_repair_failed':
      return {
        patch: {
          activeStep: 'repair',
          isRunning: true,
          quantValidationState: 'running',
          quantValidationMessage: message ?? '自动验证未通过，正在修复看板产物。',
          previewInitializationMessage: message ?? '正在自动修复并重新验证看板...',
        },
      };
    case 'preview_starting':
      return {
        reveal: true,
        patch: {
          activeStep: 'preview',
          isRunning: true,
          quantValidationState: 'passed',
          quantValidationMessage: '自动验证通过，正在确认持久看板预览。',
          previewInitializationMessage: message ?? '正在启动并确认持久看板预览...',
        },
      };
    case 'agent_paused':
      return {
        invalidate: true,
        patch: {
          isRunning: false,
          agentWorkComplete: false,
          isStartingPreview: false,
          previewInitializationMessage: message ?? '任务已暂停。',
        },
      };
    case 'validation_failed': {
      const terminal = metadata?.terminalFailure === true;
      return {
        invalidate: true,
        patch: {
          previewUrl: null,
          isStartingPreview: false,
          isRunning: !terminal,
          agentWorkComplete: false,
          quantValidationState: 'failed',
          quantValidationMessage:
            message ?? (terminal ? '自动验证最终未通过，请查看验证摘要。' : '自动验证未通过，正在等待自动修复。'),
          previewInitializationMessage:
            message ?? (terminal ? '自动验证最终未通过，暂不展示可视化看板。' : '自动验证未通过，正在自动修复看板。'),
        },
      };
    }
    case 'preview_failed':
      return {
        invalidate: true,
        terminalFailure: true,
        patch: {
          previewUrl: null,
          isStartingPreview: false,
          isRunning: false,
          quantValidationState: 'passed',
          quantValidationMessage: message ?? '自动验证已通过，但持久看板预览启动失败。',
          previewInitializationMessage: message ?? '看板代码已验证通过，但预览服务启动失败。请点击重试。',
        },
      };
    case 'validation_passed': {
      const hasPreview = typeof metadata?.previewUrl === 'string' && Boolean(metadata.previewUrl.trim());
      return {
        reveal: hasPreview,
        reconcile: hasPreview,
        patch: {
          activeStep: 'evidence_verification',
          quantValidationState: 'running',
          quantRepairPlan: null,
          quantValidationMessage:
            message ?? (hasPreview ? '正在确认看板验收终态。' : '自动检查已通过，正在等待证据验收。'),
          previewInitializationMessage: hasPreview
            ? '正在核对 Mission 验收凭据与最终预览...'
            : '证据验收通过后才会展示最终看板。',
        },
      };
    }
    default:
      return null;
  }
}
