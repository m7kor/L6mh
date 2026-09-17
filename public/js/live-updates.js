/** One polling loop; SSE accelerates updates but never replaces reconciliation. */
export function startLiveUpdates({
  refresh,
  onConnectionChange,
  createEventSource = () => new EventSource('/api/sse'),
  intervalMs = 5000,
  timeoutMs = 8000,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let stopped = false;
  let inFlight = false;
  let pollTimer;
  let requestTimer;
  let request;
  let source;

  async function update() {
    if (stopped || inFlight) return;
    inFlight = true;
    cancel(pollTimer);
    request = new AbortController();
    requestTimer = schedule(() => request.abort(), timeoutMs);
    try {
      await refresh(request.signal);
      if (!stopped) onConnectionChange(true);
    } catch {
      if (!stopped) onConnectionChange(false);
    } finally {
      cancel(requestTimer);
      inFlight = false;
      if (!stopped) pollTimer = schedule(update, intervalMs);
    }
  }

  // Native EventSource owns reconnection. Do not create duplicate retry loops.
  try {
    source = createEventSource();
    source.onmessage = update;
  } catch {
    // Polling remains available where EventSource is unsupported.
  }
  void update();

  return {
    refresh: update,
    stop() {
      stopped = true;
      cancel(pollTimer);
      cancel(requestTimer);
      request?.abort();
      source?.close();
    },
  };
}
