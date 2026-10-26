// Startup timing instrumentation. Marks are logged relative to the first eval of
// this module (T0 ~ app start), so a single launch prints where the time to
// interactivity goes. Lines are prefixed `[startup-perf]` - on desktop they land in
// the dev console; on Android they land in logcat under the `chromium` tag
// (`adb logcat chromium:I *:S | grep startup-perf`).
//
// Toggle at runtime via localStorage `ge:perf` ('0' silences). On by default so a
// profiling build measures itself without extra setup; flip to '0' to quiet it.

const T0 = performance.now();
let last = T0;

function enabled(): boolean {
  try {
    return localStorage.getItem('ge:perf') !== '0';
  } catch {
    return true;
  }
}

/** Log a startup checkpoint: cumulative ms since first eval + delta since last mark. */
export function perfMark(label: string): void {
  if (!enabled()) return;
  const now = performance.now();
  console.log(`[startup-perf] +${(now - T0).toFixed(0)}ms (Δ${(now - last).toFixed(0)}) ${label}`);
  last = now;
}

/** Time one step (sync or async) and log its own duration (doesn't move the mark cursor). */
export async function perfStep<T>(label: string, fn: () => T | Promise<T>): Promise<Awaited<T>> {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    if (enabled()) console.log(`[startup-perf] step ${label} = ${(performance.now() - t).toFixed(0)}ms`);
  }
}
