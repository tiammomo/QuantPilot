import type { ChildProcess } from 'child_process';

type AgentRuntimeStatus = 'running' | 'cancelled' | 'completed' | 'failed';

interface AgentRunRecord {
  projectId: string;
  requestId?: string;
  cli: string;
  child?: ChildProcess;
  cancel?: (reason: string) => void;
  status: AgentRuntimeStatus;
  startedAt: number;
  cancelReason?: string;
}

const globalForAgentRuntime = globalThis as unknown as {
  __quantpilot_agent_runs__?: Map<string, AgentRunRecord>;
};

const agentRuns =
  globalForAgentRuntime.__quantpilot_agent_runs__ ??
  (globalForAgentRuntime.__quantpilot_agent_runs__ = new Map<string, AgentRunRecord>());

function runKey(projectId: string, requestId?: string | null): string {
  return requestId ? `${projectId}:${requestId}` : projectId;
}

function killProcessTree(child: ChildProcess) {
  if (child.killed || typeof child.pid !== 'number') {
    return;
  }

  if (process.platform === 'win32') {
    child.kill();
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }

  setTimeout(() => {
    if (child.killed) {
      return;
    }
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 2_000).unref();
}

export function registerAgentRun(params: {
  projectId: string;
  requestId?: string;
  cli: string;
  child?: ChildProcess;
  cancel?: (reason: string) => void;
}) {
  if (!params.child && !params.cancel) {
    throw new Error('Agent runtime registration requires a child process or cancel callback.');
  }
  const key = runKey(params.projectId, params.requestId);
  agentRuns.set(key, {
    projectId: params.projectId,
    requestId: params.requestId,
    cli: params.cli,
    child: params.child,
    cancel: params.cancel,
    status: 'running',
    startedAt: Date.now(),
  });
}

export function completeAgentRun(projectId: string, requestId?: string | null) {
  const key = runKey(projectId, requestId);
  const run = agentRuns.get(key);
  if (run) {
    const completed = run.status !== 'cancelled';
    run.status = 'completed';
    agentRuns.delete(key);
    return completed;
  }
  return true;
}

export function failAgentRun(projectId: string, requestId?: string | null) {
  const key = runKey(projectId, requestId);
  const run = agentRuns.get(key);
  if (run) {
    const failed = run.status !== 'cancelled';
    run.status = 'failed';
    agentRuns.delete(key);
    return failed;
  }
  return true;
}

export function isAgentRunCancelled(projectId: string, requestId?: string | null): boolean {
  const run = agentRuns.get(runKey(projectId, requestId));
  return run?.status === 'cancelled';
}

export function cancelAgentRuns(projectId: string, requestId?: string | null, reason = '用户暂停了当前任务') {
  const keys = requestId
    ? [runKey(projectId, requestId)]
    : Array.from(agentRuns.entries())
        .filter(([, run]) => run.projectId === projectId && run.status === 'running')
        .map(([key]) => key);

  let cancelled = 0;
  for (const key of keys) {
    const run = agentRuns.get(key);
    if (!run || run.status !== 'running') {
      continue;
    }
    run.status = 'cancelled';
    run.cancelReason = reason;
    try {
      run.cancel?.(reason);
    } catch (error) {
      console.error('[AgentRuntime] Cancel callback failed:', error);
    }
    if (run.child) {
      killProcessTree(run.child);
    }
    cancelled += 1;
  }

  return {
    cancelled,
    activeCount: Array.from(agentRuns.values()).filter(
      (run) => run.projectId === projectId && run.status === 'running'
    ).length,
  };
}
