async function probeHttp(url, { method = 'GET', json = false, timeoutMs = 2500 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let statusCode = null;
  try {
    const response = await fetch(url, { method, signal, redirect: 'manual' });
    statusCode = response.status;
    const data = json ? await response.json() : undefined;
    if (!json) await response.body?.cancel();
    return { ok: statusCode >= 200 && statusCode < 400, statusCode, ...(json ? { data } : {}) };
  } catch (error) {
    return { ok: false, statusCode, error: signal.aborted ? 'timeout' : error.message };
  }
}

module.exports = { probeHttp };
