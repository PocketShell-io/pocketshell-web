/**
 * Real ssh2 key parser under the browser shim — the hook serves the compiled
 * src/shims/ssh2-crypto.ts to ssh2's `require('crypto')`, so BaseKey.sign
 * (the function ssh2's client-auth path calls) runs the containment guard on
 * genuinely parsed keys. No parsing is faked and no signer is mocked; the
 * elliptic probe must end every flow at zero ECDSA signature calls.
 */
import assert from 'node:assert/strict';
import { sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLab } from './lab-harness.mjs';

// createRequire/require take paths (or URL objects) — not href strings.
const labRequire = (baseDirUrl, specifier) =>
  createRequire(fileURLToPath(new URL('.', baseDirUrl)))(specifier);


export async function runParserLab(builtDirUrl) {
  const requireFromLab = (specifier) => labRequire(builtDirUrl, specifier);
  const { utils: ssh2Utils } = requireFromLab('ssh2');
  const { ellipticProbe } = requireFromLab('./elliptic-probe.cjs');
  const keys = requireFromLab('./keys.cjs');
  const parseKey = ssh2Utils.parseKey;

  const lab = createLab('ssh2-keyparser-lab');
  const data = Buffer.from('ssh2 keyparser containment probe');
  assert.equal(ellipticProbe.ecSignCalls, 0, 'probe must start at zero');

  const parsedKeyOf = (pem, passphrase) => {
    const parsed = parseKey(pem, passphrase);
    assert.ok(!(parsed instanceof Error), `parseKey failed: ${parsed?.message}`);
    return parsed;
  };

  await lab.test('ECDSA OpenSSH keys (nistp256/384/521) parsed by real ssh2 refuse to sign', () => {
    for (const bits of [256, 384, 521]) {
      const dir = new keys.KeyDir('lab-parser-ec');
      try {
        const pem = dir.sshgen('ecdsa', { bits });
        const parsed = parsedKeyOf(pem);
        assert.equal(parsed.type, `ecdsa-sha2-nistp${bits}`);
        const result = parsed.sign(data);
        assert.ok(result instanceof Error, `nistp${bits} signed instead of refusing`);
        assert.match(result.message, /ECDSA/);
        assert.equal(result.code, 'ERR_BROWSER_ECDSA_UNSUPPORTED');
      } finally {
        dir.cleanup();
      }
    }
    assert.equal(ellipticProbe.ecSignCalls, 0);
  });

  await lab.test('legacy SEC1 "BEGIN EC PRIVATE KEY" refuses with the stable error', () => {
    const ec = keys.ephemeralEc('prime256v1');
    const parsed = parsedKeyOf(ec.sec1);
    assert.equal(parsed.type, 'ecdsa-sha2-nistp256');
    const result = parsed.sign(data);
    assert.ok(result instanceof Error);
    assert.match(result.message, /ECDSA/);
    assert.equal(ellipticProbe.ecSignCalls, 0);
  });

  await lab.test('PKCS#8 EC PEM cannot even enter ssh2 (parser rejects the container)', () => {
    const parsed = parseKey(keys.ephemeralEc('prime256v1').pkcs8);
    assert.ok(parsed instanceof Error);
    assert.equal(ellipticProbe.ecSignCalls, 0);
  });

  await lab.test('refusal survives the exact client.js call shape key.sign(buf, hashAlgo)', () => {
    const dir = new keys.KeyDir('lab-parser-ec384');
    try {
      const parsed = parsedKeyOf(dir.sshgen('ecdsa', { bits: 384 }));
      const result = parsed.sign(data, 'sha384');
      assert.ok(result instanceof Error);
      assert.match(result.message, /ECDSA/);
    } finally {
      dir.cleanup();
    }
    assert.equal(ellipticProbe.ecSignCalls, 0);
  });

  await lab.test('RSA stays positive: OpenSSH key signs sha256/sha512 and verifies', () => {
    const dir = new keys.KeyDir('lab-parser-rsa');
    try {
      const parsed = parsedKeyOf(dir.sshgen('rsa', { bits: 2048 }));
      assert.equal(parsed.type, 'ssh-rsa');
      for (const algo of ['sha256', 'sha512']) {
        const sig = parsed.sign(data, algo);
        assert.ok(Buffer.isBuffer(sig));
        assert.equal(nodeVerify(algo, data, parsed.getPublicPEM(), sig), true);
      }
    } finally {
      dir.cleanup();
    }
    assert.equal(ellipticProbe.ecSignCalls, 0);
  });

  await lab.test('legacy PKCS#1 "BEGIN RSA PRIVATE KEY" stays positive', () => {
    const rsa = keys.ephemeralRsa();
    const parsed = parsedKeyOf(rsa.pkcs1);
    assert.equal(parsed.type, 'ssh-rsa');
    const sig = parsed.sign(data, 'sha256');
    assert.ok(Buffer.isBuffer(sig));
    assert.equal(nodeVerify('sha256', data, rsa.spki, sig), true);
    assert.equal(ellipticProbe.ecSignCalls, 0);
  });

  await lab.test('Ed25519 stays positive on the null-algorithm path (64-byte raw)', () => {
    const dir = new keys.KeyDir('lab-parser-ed');
    try {
      const parsed = parsedKeyOf(dir.sshgen('ed25519'));
      assert.equal(parsed.type, 'ssh-ed25519');
      const sig = parsed.sign(data);
      assert.ok(Buffer.isBuffer(sig));
      assert.equal(sig.length, 64);
      assert.equal(nodeVerify(null, data, parsed.getPublicPEM(), sig), true);
    } finally {
      dir.cleanup();
    }
    assert.equal(ellipticProbe.ecSignCalls, 0);
    assert.equal(ellipticProbe.eddsaSignCalls, 0);
  });

  await lab.test('encrypted OpenSSH ed25519 + correct passphrase decrypts and signs', () => {
    const dir = new keys.KeyDir('lab-parser-edenc');
    try {
      const parsed = parsedKeyOf(dir.sshgen('ed25519', { passphrase: 'correct horse' }), 'correct horse');
      assert.equal(parsed.type, 'ssh-ed25519');
      const sig = parsed.sign(data);
      assert.ok(Buffer.isBuffer(sig));
      assert.equal(sig.length, 64);
      assert.equal(nodeVerify(null, data, parsed.getPublicPEM(), sig), true);
    } finally {
      dir.cleanup();
    }
    assert.equal(ellipticProbe.ecSignCalls, 0);
  });

  await lab.test('wrong passphrase fails the decrypt before any signing', () => {
    const dir = new keys.KeyDir('lab-parser-edwrong');
    try {
      const pem = dir.sshgen('ed25519', { passphrase: 'correct horse' });
      const parsed = parseKey(pem, 'wrong battery');
      assert.ok(parsed instanceof Error);
      assert.match(parsed.message, /passphrase|decrypt/i);
    } finally {
      dir.cleanup();
    }
    assert.equal(ellipticProbe.ecSignCalls, 0);
  });

  await lab.test('truncated SEC1 body fails closed (parser or boundary, never elliptic)', () => {
    const sec1 = keys.ephemeralEc('secp384r1').sec1;
    const truncated = sec1.slice(0, sec1.indexOf('-----END') - 12) + '-----END EC PRIVATE KEY-----';
    const parsed = parseKey(truncated);
    if (!(parsed instanceof Error)) {
      const result = parsed.sign(data);
      assert.ok(result instanceof Error, 'truncated key signed');
    }
    assert.equal(ellipticProbe.ecSignCalls, 0);
  });

  lab.finish();
}
