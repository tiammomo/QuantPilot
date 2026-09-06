import type {
  GenerationPreviewState,
  QuantValidationState,
  QuantValidationRepairPlan,
} from './generation-preview-state';

export async function readPreviewValidation({
  projectId,
  isVisualCheck,
  apiBase,
  request,
  update,
}: {
  projectId: string;
  isVisualCheck: boolean;
  apiBase: string;
  request: typeof fetch;
  update: (patch: Partial<GenerationPreviewState>) => void;
}): Promise<QuantValidationState> {
  const setQuantValidationState = (quantValidationState: QuantValidationState) => update({ quantValidationState });
  const setQuantValidationMessage = (quantValidationMessage: string) => update({ quantValidationMessage });
  const setQuantRepairPlan = (quantRepairPlan: QuantValidationRepairPlan | null) => update({ quantRepairPlan });

  try {
    const response = await request(`${apiBase}/api/projects/${projectId}/quant/validation`, {
      method: 'GET',
      cache: 'no-store',
    });
    if (!response.ok) {
      return 'unknown';
    }
    const payload = await response.json();
    let report = payload?.data ?? null;
    const generationState = payload?.generationState ?? null;
    const generationRequestId = typeof generationState?.requestId === 'string' ? generationState.requestId : null;
    const validationRunId = typeof report?.runId === 'string' ? report.runId : null;
    const generationIsActive = ['pending', 'running', 'repairing'].includes(String(generationState?.status ?? ''));
    const validationMatchesGeneration = !generationRequestId
      ? true
      : validationRunId
        ? validationRunId === generationRequestId
        : ['completed', 'failed'].includes(String(generationState?.status ?? ''));

    if (!validationMatchesGeneration) {
      setQuantValidationState('running');
      setQuantValidationMessage('正在等待当前生成任务的自动验证结果。');
      setQuantRepairPlan(null);
      return 'running';
    }

    const staleReport = Array.isArray(report?.checks)
      ? report.checks.some((check: any) => check?.id === 'validation_report_stale')
      : false;
    if (staleReport && generationIsActive) {
      setQuantValidationState('running');
      setQuantValidationMessage('当前产物仍在更新，正在等待本轮自动验证。');
      setQuantRepairPlan(null);
      return 'running';
    }
    if (staleReport && !isVisualCheck && !generationIsActive) {
      setQuantValidationState('running');
      setQuantValidationMessage('生成产物已更新，正在重新执行自动验证。');
      setQuantRepairPlan(null);
      const rerunResponse = await request(`${apiBase}/api/projects/${projectId}/quant/validation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({}),
      });
      if (rerunResponse.ok) {
        const rerunPayload = await rerunResponse.json().catch(() => null);
        report = rerunPayload?.data ?? report;
        payload.repairPlan = rerunPayload?.repairPlan ?? payload.repairPlan;
      }
    }
    if (report?.passed === true || report?.status === 'passed') {
      setQuantValidationState('passed');
      setQuantValidationMessage('自动验证通过。');
      setQuantRepairPlan(null);
      return 'passed';
    }
    if (report?.passed === false || report?.status === 'failed') {
      const repairPlan =
        payload?.repairPlan && payload.repairPlan.status === 'needed'
          ? (payload.repairPlan as QuantValidationRepairPlan)
          : null;
      const failedChecks = Array.isArray(report?.checks)
        ? report.checks
            .filter((check: any) => check?.status === 'failed')
            .map((check: any) => check?.summary || check?.name || check?.id)
            .filter(Boolean)
        : [];
      setQuantValidationState('failed');
      setQuantRepairPlan(repairPlan);
      setQuantValidationMessage(
        failedChecks.length ? `自动验证未通过：${failedChecks.join('；')}` : '自动验证未通过，请查看验证摘要。'
      );
      return 'failed';
    }
  } catch (error) {
    console.warn('[Preview] failed to read quant validation report:', error);
  }
  return 'unknown';
}
