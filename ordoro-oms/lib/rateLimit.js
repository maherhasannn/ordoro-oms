/**
 * Per-supplier rate limiter.
 * Ensures a minimum delay between consecutive API calls to avoid throttling.
 */

const lastCall = new Map(); // supplier -> timestamp

export async function rateLimit(supplier, minDelayMs = 500) {
  const now = Date.now();
  const last = lastCall.get(supplier) || 0;
  const wait = Math.max(0, minDelayMs - (now - last));
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastCall.set(supplier, Date.now());
}
