/**
 * ssh2 ships an optional native crypto addon; its build cannot enter a
 * browser bundle (rollup parses the .node binary as JS and dies). The
 * require site is inside try/catch and destructures cipher classes that
 * fall back to ssh2's portable JS paths when absent — so replacing the
 * binary with an empty module at install time is exactly equivalent to
 * "native addon not available", the normal case on most installs.
 */
const fs = require('node:fs');
const path = require('node:path');

const targets = [
  path.join(__dirname, '..', 'node_modules', 'ssh2', 'lib', 'protocol', 'crypto', 'build', 'Release', 'sshcrypto.node'),
];

for (const target of targets) {
  if (fs.existsSync(target)) {
    fs.writeFileSync(target, 'module.exports = {};\n');
    console.log('patched', path.relative(process.cwd(), target));
  }
}
