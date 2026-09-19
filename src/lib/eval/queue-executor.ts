import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { buildBenchmarkArgs, createRepairTicketsForRun, getQuantEvalRun } from './runtime';
import { EVAL_LEASE_MS, evalQueueStore, type EvalQueueClaim } from './queue-store';
import { LOG_DIR, REPORTS_DIR, ROOT } from './paths';
import { isRecord } from './runtime-utils';

export function reportBelongsToClaim(value: unknown, claim: EvalQueueClaim): boolean {
  if (!isRecord(value) || !isRecord(value.metadata)) return false;
  const { queue, suite, runtime } = value.metadata;
  return isRecord(queue) && queue.id === claim.item.id && queue.leaseToken === claim.leaseToken
    && isRecord(suite) && suite.mode === claim.item.mode
    && isRecord(runtime) && runtime.configuredModel === claim.item.model;
}

function stopOwnedProcess(child: ChildProcess): Promise<void> {
  const send = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.error('[EvalWorker] Process stop failed:', error);
    }
  };
  send('SIGTERM');
  return new Promise((resolve) => setTimeout(() => {
    // Also terminate descendants if the benchmark leader exited on SIGTERM.
    send('SIGKILL');
    resolve();
  }, 3_000));
}

/** Only the owning Worker holds a ChildProcess; Web cancellation updates the DB. */
export async function executeEvalClaim(claim: EvalQueueClaim, signal: AbortSignal): Promise<void> {
  const { item } = claim;
  const reportId = `report-${BigInt(`0x${randomUUID().replaceAll('-', '')}`)}`;
  const logPath = path.join(LOG_DIR, `${item.id}-${claim.attemptCount}.log`);
  let child: ChildProcess | undefined;
  let log: Awaited<ReturnType<typeof fs.open>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  let lostLease = false;
  let childClosed = false;
  let heartbeatPending = false;
  let leaseDeadline = 0;
  let nextHeartbeatAt = 0;
  const stop = () => {
    if (child && !childClosed && !stopping) stopping = stopOwnedProcess(child);
  };
  try {
    if (signal.aborted) throw new Error('评测 Worker 正在停止。');
    const initialHeartbeatAt = performance.now();
    if (!await evalQueueStore.heartbeat(claim)) return;
    leaseDeadline = initialHeartbeatAt + EVAL_LEASE_MS;
    nextHeartbeatAt = initialHeartbeatAt + 10_000;
    await fs.mkdir(LOG_DIR, { recursive: true });
    log = await fs.open(logPath, 'a');
    if (performance.now() >= leaseDeadline) throw new Error('评测租约在启动进程前已过期。');
    child = spawn(process.execPath, buildBenchmarkArgs(item), {
      cwd: ROOT,
      env: {
        ...process.env,
        QUANTPILOT_EVAL_REPORT_ID: reportId,
        QUANTPILOT_EVAL_QUEUE_ID: item.id,
        QUANTPILOT_EVAL_LEASE_TOKEN: claim.leaseToken,
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', log.fd, log.fd],
    });
    const completion = new Promise<{ code: number | null; error: string | null }>((resolve) => {
      let spawnError: string | null = null;
      child!.once('error', (error) => { spawnError = error.message; });
      child!.once('close', (code, exitSignal) => {
        childClosed = true;
        resolve({ code, error: spawnError ?? (code === 0 ? null : `benchmark 退出码 ${code ?? exitSignal ?? 'unknown'}`) });
      });
    });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    timer = setInterval(() => {
      const now = performance.now();
      // A blocked database request cannot disable the local expiry watchdog.
      if (now >= leaseDeadline) { lostLease = true; stop(); }
      if (heartbeatPending || lostLease || now < nextHeartbeatAt) return;
      heartbeatPending = true;
      nextHeartbeatAt = now + 10_000;
      void evalQueueStore.heartbeat(claim).then((valid) => {
        if (!valid) { lostLease = true; stop(); }
        else if (!lostLease) leaseDeadline = now + EVAL_LEASE_MS;
      }).catch(() => {
        // Loss of DB connectivity must not leave an unfenced process running.
        lostLease = true;
        stop();
      }).finally(() => { heartbeatPending = false; });
    }, 1_000);
    if (!await evalQueueStore.recordProcess(claim, child.pid ?? null, path.relative(ROOT, logPath))) {
      lostLease = true;
      stop();
    }
    const result = await completion;
    await stopping;
    if (lostLease) return;
    if (signal.aborted) throw new Error('评测 Worker 已停止。');
    const filePath = path.join(REPORTS_DIR, `${reportId}.json`);
    const raw = await fs.readFile(filePath, 'utf8').then(JSON.parse).catch(() => null);
    const report = reportBelongsToClaim(raw, claim) ? await getQuantEvalRun(reportId) : null;
    const passed = result.code === 0 && report?.passed === true;
    const committed = await evalQueueStore.finish(claim, {
      status: passed ? 'passed' : 'failed', exitCode: result.code,
      reportId: report?.id, reportPath: report?.filePath,
      error: passed ? null : result.error ?? (report ? '评测报告未通过。' : '缺少属于本次任务的有效评测报告。'),
    });
    if (committed && report && !report.passed) {
      await createRepairTicketsForRun(report).catch((error) => {
        console.error('[EvalWorker] Repair ticket creation failed:', error);
      });
    }
  } catch (error) {
    stop();
    await stopping;
    await evalQueueStore.finish(claim, {
      status: 'failed', exitCode: null, error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer) clearInterval(timer);
    signal.removeEventListener('abort', stop);
    await log?.close();
    await evalQueueStore.releaseCancelled(claim);
  }
}
