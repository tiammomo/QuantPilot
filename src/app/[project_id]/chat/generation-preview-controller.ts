import type { QuantGenerationTerminalSnapshot } from '@/lib/quant/generation-terminal';
import { planPreviewReconciliation } from './preview-reconciliation';
import { readPreviewValidation } from './preview-validation';
import { generationStatusUpdate, INITIAL_PREVIEW_STATE, type GenerationPreviewState } from './generation-preview-state';

type Operation = { epoch: number; abort: AbortController };
type Options = {
  projectId: string;
  isVisualCheck: boolean;
  apiBase?: string;
  fetch?: typeof fetch;
  onReveal?: () => void;
  onAccepted?: () => void;
};

/** Owns preview/terminal requests for one mounted project and generation. */
export class GenerationPreviewController {
  private state: GenerationPreviewState = { ...INITIAL_PREVIEW_STATE };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private active = true;
  private operations = new Set<Operation>();
  private starting: Operation | null = null;
  private reading: Operation | null = null;
  private expectedRequestId: string | null = null;
  private recoveryAttempt: string | null = null;
  private stopped = false;
  private terminalFailure = false;
  hasActiveRequests = false;

  constructor(private readonly options: Options) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  activate = () => {
    this.active = true;
  };
  dispose = () => {
    this.active = false;
    this.invalidate();
  };

  private update(patch: Partial<GenerationPreviewState>) {
    if (!this.active) return;
    if (Object.entries(patch).every(([key, value]) => this.state[key as keyof GenerationPreviewState] === value))
      return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private invalidate() {
    this.epoch += 1;
    this.operations.forEach((operation) => operation.abort.abort());
    this.operations.clear();
    this.starting = null;
    this.reading = null;
  }
  private operation(): Operation {
    const operation = { epoch: this.epoch, abort: new AbortController() };
    this.operations.add(operation);
    return operation;
  }
  private current(operation: Operation) {
    return this.active && operation.epoch === this.epoch && !operation.abort.signal.aborted;
  }
  private request(operation: Operation, input: RequestInfo | URL, init?: RequestInit) {
    if (!this.current(operation)) throw new DOMException('Superseded preview request', 'AbortError');
    return (this.options.fetch ?? fetch)(input, {
      ...init,
      signal: AbortSignal.any([operation.abort.signal, AbortSignal.timeout(60_000)]),
    });
  }
  private endpoint(path: string) {
    return `${this.options.apiBase ?? ''}/api/projects/${this.options.projectId}/${path}`;
  }
  private async snapshot(operation: Operation) {
    const response = await this.request(operation, this.endpoint('generation/status'), { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json();
    const snapshot = (payload?.data ?? null) as QuantGenerationTerminalSnapshot | null;
    if (!this.current(operation) || !snapshot) return null;
    if (this.expectedRequestId && snapshot.requestId !== this.expectedRequestId) return null;
    return snapshot;
  }

  setRunning = (isRunning: boolean) => {
    this.update({ isRunning });
  };
  setWorkComplete = (agentWorkComplete: boolean) => {
    this.update({ agentWorkComplete });
  };
  setMessage = (previewInitializationMessage: string) => {
    this.update({ previewInitializationMessage });
  };
  trackRequest = (requestId: string, submittedRequestId: string) => {
    if (this.expectedRequestId === submittedRequestId) this.expectedRequestId = requestId;
  };
  beginGeneration = (requestId: string) => {
    this.invalidate();
    this.expectedRequestId = requestId;
    this.stopped = false;
    this.terminalFailure = false;
    this.recoveryAttempt = null;
    this.update({
      ...INITIAL_PREVIEW_STATE,
      isRunning: true,
      quantValidationState: 'running',
      activeStep: 'request_received',
      previewInitializationMessage: '正在接收研究请求并准备执行计划...',
    });
  };
  rejectRequest = (submittedRequestId: string) => {
    if (this.expectedRequestId !== submittedRequestId) return;
    this.invalidate();
    this.expectedRequestId = null;
    this.update({ isRunning: false, isStartingPreview: false });
  };

  start = async (options: { requireValidation?: boolean; acceptedSnapshot?: QuantGenerationTerminalSnapshot } = {}) => {
    if (!this.active || this.options.isVisualCheck) return false;
    if (this.state.previewUrl) return true;
    if (this.starting) return false;
    this.stopped = false;
    this.terminalFailure = false;
    const operation = this.operation();
    this.starting = operation;
    try {
      this.update({
        isStartingPreview: true,
        activeStep: options.requireValidation ? 'validation' : 'preview',
        previewInitializationMessage: options.requireValidation ? '正在检查自动验证结果...' : '正在启动预览服务...',
      });
      const snapshot = options.acceptedSnapshot ?? (await this.snapshot(operation));
      if (!this.current(operation)) return false;
      if (!snapshot || (this.expectedRequestId && snapshot.requestId !== this.expectedRequestId)) {
        this.update({ previewInitializationMessage: '暂时无法确认生成终态，请稍后重试。' });
        return false;
      }
      if (snapshot.missionAcceptanceRequired && !snapshot.missionAcceptanceSatisfied) {
        this.update({ activeStep: 'evidence_verification', previewUrl: null, previewInitializationMessage: '正在等待 PI Agent 证据验收，暂不展示预览。' });
        return false;
      }
      if (snapshot.validationStatus !== 'passed' || !snapshot.validationMatchesCurrentRun) {
        this.update({
          previewInitializationMessage:
            snapshot.validationStatus === 'failed'
              ? '自动验证未通过，暂不展示可视化看板。'
              : '自动验证尚未完成，暂不展示可视化看板。',
        });
        return false;
      }
      if (snapshot.status === 'ready' && snapshot.previewUrl) {
        this.adopt(snapshot.previewUrl);
        return true;
      }
      if (snapshot.status !== 'preview_pending') {
        this.update({ previewInitializationMessage: '持久看板预览尚未进入可恢复状态。' });
        return false;
      }
      this.update({ activeStep: 'preview', previewInitializationMessage: '正在启动并确认预览服务...' });
      const response = await this.request(operation, this.endpoint('preview/start'), { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (!this.current(operation)) return false;
      if (!response.ok) throw new Error(payload?.error || response.statusText || '预览启动失败');
      const data = payload?.data ?? payload;
      const url = data?.url ?? data?.previewUrl ?? payload?.url ?? payload?.previewUrl;
      if (typeof url !== 'string' || !url.trim()) throw new Error('预览服务未返回可用地址');
      this.adopt(url);
      return true;
    } catch (error) {
      if (this.current(operation)) {
        this.terminalFailure = true;
        this.update({
          previewInitializationMessage: `预览启动失败：${error instanceof Error ? error.message : '请求异常'}`,
        });
      }
      return false;
    } finally {
      this.operations.delete(operation);
      if (this.starting === operation) {
        this.starting = null;
        this.update({ isStartingPreview: false });
      }
    }
  };

  private adopt(previewUrl: string) {
    const changed = this.state.previewUrl !== previewUrl;
    this.update({ previewUrl, previewInitializationMessage: '预览已就绪' });
    if (changed) this.options.onReveal?.();
  }

  stop = async () => {
    this.invalidate();
    this.stopped = true;
    this.update({ previewUrl: null, isStartingPreview: false, previewInitializationMessage: '预览已停止。' });
    const operation = this.operation();
    try {
      const response = await this.request(operation, this.endpoint('preview/stop'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'explicit-user-stop' }),
      });
      if (!response.ok && this.current(operation))
        this.update({ previewInitializationMessage: '预览停止请求失败，请重试。' });
    } catch {
      if (this.current(operation)) this.update({ previewInitializationMessage: '预览停止请求失败，请重试。' });
    } finally {
      this.operations.delete(operation);
    }
  };

  reconcile = async () => {
    if (!this.active || this.reading || !this.options.projectId) return;
    const operation = this.operation();
    this.reading = operation;
    try {
      const snapshot = await this.snapshot(operation);
      if (!snapshot || !this.current(operation)) return;
      const plan = planPreviewReconciliation({
        projectId: this.options.projectId,
        snapshot,
        currentPreviewUrl: this.state.previewUrl,
        attemptedRecoveryKey: this.recoveryAttempt,
      });
      if (plan.action === 'withhold_until_acceptance') {
        this.invalidate();
        this.update({
          previewUrl: null,
          isStartingPreview: false,
          isRunning: true,
          agentWorkComplete: false,
          quantValidationState: 'running',
          quantValidationMessage: '自动检查已完成，正在等待 PI Agent 证据验收。',
          previewInitializationMessage: '证据验收通过后才会展示最终看板。',
          activeStep: 'evidence_verification',
        });
        return;
      }
      if (plan.action === 'ready') {
        if (this.starting) this.invalidate();
        this.expectedRequestId = null;
        this.update({
          quantValidationState: 'passed',
          quantRepairPlan: null,
          quantValidationMessage: '自动验证通过，看板预览已就绪。',
          agentWorkComplete: true,
          isStartingPreview: false,
          isRunning: false,
        });
        this.options.onAccepted?.();
        if (!this.stopped && !this.terminalFailure) this.adopt(plan.previewUrl);
        return;
      }
      if (plan.action === 'start_once') {
        if (this.options.isVisualCheck) {
          this.update({ previewInitializationMessage: '已验收看板当前没有运行中的预览。' });
          return;
        }
        if (!this.stopped && !this.terminalFailure && !this.starting) {
          this.update({
            quantValidationState: 'passed',
            quantValidationMessage: '自动验证通过，正在恢复持久看板预览。',
          });
          this.recoveryAttempt = plan.attemptKey;
          this.options.onReveal?.();
          void this.start({ acceptedSnapshot: snapshot });
        }
        return;
      }
      if (snapshot.status === 'needs_revalidation') {
        this.invalidate();
        this.update({
          previewUrl: null,
          isStartingPreview: false,
          isRunning: false,
          agentWorkComplete: false,
          quantValidationState: 'failed',
          quantValidationMessage: '看板文件已在任务完成后更新，需要发起新一轮验收。',
          previewInitializationMessage: '看板已更新，请重新生成并验收后查看最终预览。',
        });
      } else if (snapshot.status === 'running') {
        if (this.starting) this.invalidate();
        this.update({
          isRunning: true,
          isStartingPreview: false,
          previewUrl: null,
          agentWorkComplete: false,
          quantValidationState: 'running',
          quantValidationMessage: '当前生成任务尚未完成，正在等待验证和预览终态。',
          activeStep: snapshot.activeStep ?? null,
        });
        if (snapshot.validationStatus === 'pending') {
          this.update({ previewUrl: null });
          if (!snapshot.activeStep && !this.hasActiveRequests && this.current(operation))
            await readPreviewValidation({
              projectId: this.options.projectId,
              isVisualCheck: this.options.isVisualCheck,
              apiBase: this.options.apiBase ?? '',
              request: (input, init) => this.request(operation, input, init),
              update: (patch) => {
                if (this.current(operation)) this.update(patch);
              },
            });
        }
        if (this.current(operation) && !this.state.previewUrl)
          this.update({ previewInitializationMessage: snapshot.stepSummary || '任务正在执行，等待最新阶段信息...' });
      } else if (snapshot.status === 'failed') {
        this.invalidate();
        this.expectedRequestId = null;
        this.update({
          isRunning: false,
          agentWorkComplete: false,
          previewUrl: null,
          isStartingPreview: false,
          quantValidationState: 'failed',
          quantValidationMessage: snapshot.errorMessage || '生成或自动验证最终失败，请查看执行摘要。',
          previewInitializationMessage: snapshot.errorMessage || '生成终态失败，暂时无法展示看板。',
        });
      } else if (['cancelled', 'needs_clarification', 'refused'].includes(snapshot.status)) {
        this.invalidate();
        this.expectedRequestId = null;
        this.update({ isRunning: false, isStartingPreview: false, previewUrl: null, agentWorkComplete: false });
      }
    } catch {
      // A failed poll preserves the last observed state; a later poll retries.
    } finally {
      this.operations.delete(operation);
      if (this.reading === operation) this.reading = null;
    }
  };

  handleStatus = (status: string, message?: string, metadata?: Record<string, unknown>) => {
    const result = generationStatusUpdate(status, message, metadata);
    if (!result) return false;
    if (
      this.expectedRequestId &&
      typeof metadata?.requestId === 'string' &&
      metadata.requestId !== this.expectedRequestId
    )
      return true;
    if (result.invalidate) this.invalidate();
    if (result.terminalFailure) this.terminalFailure = true;
    this.update(result.patch);
    if (result.reveal) this.options.onReveal?.();
    if (result.reconcile) void this.reconcile();
    return true;
  };
}
