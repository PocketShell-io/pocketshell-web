/** Minimal sequential test harness for the node-hook lab (assert-based). */
export function createLab(name) {
  const results = [];
  const started = Date.now();
  return {
    async test(title, fn) {
      const t0 = Date.now();
      try {
        await fn();
        results.push({ title, ok: true, ms: Date.now() - t0 });
        process.stdout.write(`   ✓ ${title} (${Date.now() - t0}ms)\n`);
      } catch (err) {
        results.push({ title, ok: false, err, ms: Date.now() - t0 });
        process.stdout.write(`   × ${title} (${Date.now() - t0}ms)\n`);
        process.stdout.write(`     ${(err instanceof Error ? err.stack : String(err))?.split('\n').slice(0, 6).join('\n     ')}\n`);
      }
    },
    finish() {
      const failed = results.filter((r) => !r.ok);
      process.stdout.write(
        `${name}: ${results.length - failed.length}/${results.length} passed in ${Date.now() - started}ms\n`,
      );
      if (failed.length > 0) {
        const err = new Error(`${failed.length} lab test(s) failed`);
        (err ).failures = failed;
        throw err;
      }
    },
  };
}
