// A few counters, exposed in Prometheus text format at /metrics when METRICS_TOKEN is set.
export const metrics = { pushes: 0, accepted: 0, refused: 0, flushFailures: 0, loginEmails: 0, connections: 0 };

export function renderMetrics(extra: Record<string, number>) {
  const all = { ...extra, ...metrics, memory_rss_bytes: process.memoryUsage().rss };
  return (
    Object.entries(all)
      .map(([k, v]) => `betterdraw_${k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())} ${v}`)
      .join("\n") + "\n"
  );
}
