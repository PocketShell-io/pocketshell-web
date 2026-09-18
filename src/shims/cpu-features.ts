/**
 * Stub for ssh2's optional native accelerator (cpu-features) — the real
 * package ships a compiled addon that cannot enter a browser bundle. The
 * API is a function returning a feature-flags object; "none available"
 * just makes ssh2 use its portable code paths.
 */
export default function cpuFeatures(): Record<string, boolean> {
  return {};
}
