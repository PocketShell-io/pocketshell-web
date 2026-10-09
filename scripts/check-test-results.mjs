// Refuse a vacuous green (web#5): the vitest JSON report must show tests
// actually executed, none failed, and every REQUIRED suite below ran with at
// least one passing test — a security regression test that silently stops
// running (renamed, excluded, skipped) fails the gate instead of disappearing.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const REQUIRED = ['gatewayDialRefusal.test.ts', 'dialPathsRefusal.test.ts'];

const path = process.argv[2] ?? 'vitest-results.json';
const report = JSON.parse(readFileSync(path, 'utf8'));
const problems = [];

if (!(report.numTotalTests > 0)) problems.push(`no tests executed (numTotalTests=${report.numTotalTests})`);
if (report.numFailedTests !== 0) problems.push(`${report.numFailedTests} test(s) failed`);
if (report.numFailedTestSuites !== 0) problems.push(`${report.numFailedTestSuites} suite(s) failed`);

for (const name of REQUIRED) {
  const file = (report.testResults ?? []).find((r) => basename(r.name) === name);
  const passed = file ? file.assertionResults.filter((a) => a.status === 'passed').length : 0;
  const notPassed = file ? file.assertionResults.filter((a) => a.status !== 'passed').length : 0;
  console.log(`${name}: ${passed} passed, ${notPassed} not passed`);
  if (!file) problems.push(`required suite ${name} did not run`);
  else if (passed === 0 || notPassed !== 0) problems.push(`required suite ${name}: ${passed} passed, ${notPassed} not passed`);
}

console.log(`total: ${report.numPassedTests}/${report.numTotalTests} passed (${report.numTotalTestSuites} suites)`);
if (problems.length > 0) {
  for (const p of problems) console.error(`FAIL: ${p}`);
  process.exit(1);
}
console.log('PASS');
