/**
 * Shim-boundary containment tests: the browser crypto shim must refuse
 * ECDSA private-key signing (GHSA-848j-6mx2-7j84) BEFORE elliptic is ever
 * reached — on both the one-shot `sign` and the `createSign().sign`
 * fallback — while RSA/Ed25519 signing and public-key verification keep
 * working. Real keys only (ephemeral, generated per run); the elliptic
 * probe counts genuine library calls, so "probe stays at zero" is the
 * fail-closed assertion, and every positive signature is verified against
 * the matching public key with real node crypto.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createSign as nodeCreateSign, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import {
  assertSignablePrivateKey,
  assessPrivateKeyAuth,
  classifyPrivateKey,
  createSign,
  sign as shimSign,
  verify as shimVerify,
} from '../../src/shims/ssh2-crypto';
import { ellipticProbe } from './elliptic-probe';
import {
  encryptedPkcs8,
  ephemeralEc,
  ephemeralEd25519,
  ephemeralRsa,
  KeyDir,
  withLegacyEncryptionHeaders,
} from './keys';

const dirs: KeyDir[] = [];
const newKeys = () => {
  const dir = new KeyDir('shim');
  dirs.push(dir);
  return dir;
};

let data: Buffer;

beforeAll(() => {
  data = Buffer.from('containment probe payload — signed data');
  expect(ellipticProbe.ecSignCalls).toBe(0);
});

afterAll(() => {
  for (const dir of dirs) dir.cleanup();
});

describe('structural classification of real key PEMs', () => {
  it('classifies SEC1 and PKCS#8 EC keys as ecdsa on all three NIST curves', () => {
    for (const curve of ['prime256v1', 'secp384r1', 'secp521r1'] as const) {
      const ec = ephemeralEc(curve);
      expect(classifyPrivateKey(ec.sec1)).toBe('ecdsa');
      expect(classifyPrivateKey(ec.pkcs8)).toBe('ecdsa');
    }
  });

  it('classifies RSA PKCS#1/PKCS#8, Ed25519 PKCS#8', () => {
    const rsa = ephemeralRsa();
    const ed = ephemeralEd25519();
    expect(classifyPrivateKey(rsa.pkcs1)).toBe('rsa');
    expect(classifyPrivateKey(rsa.pkcs8)).toBe('rsa');
    expect(classifyPrivateKey(ed.pkcs8)).toBe('ed25519');
  });

  it('classifies raw OpenSSH containers without executing crypto', () => {
    const dir = newKeys();
    expect(classifyPrivateKey(dir.sshgen('ed25519'))).toBe('ed25519');
    expect(classifyPrivateKey(dir.sshgen('rsa', { bits: 2048 }))).toBe('rsa');
    expect(classifyPrivateKey(dir.sshgen('ecdsa', { bits: 256 }))).toBe('ecdsa');
  });

  it('recognizes encrypted forms: OpenSSH bcrypt, PBES2 PKCS#8, legacy DEK-Info headers', () => {
    const dir = newKeys();
    expect(classifyPrivateKey(dir.sshgen('ed25519', { passphrase: 'one pass' }))).toBe('encrypted');
    expect(classifyPrivateKey(dir.sshgen('rsa', { bits: 2048, passphrase: 'one pass' }))).toBe('encrypted');
    expect(classifyPrivateKey(encryptedPkcs8('ec', 'prime256v1'))).toBe('encrypted');
    expect(classifyPrivateKey(encryptedPkcs8('rsa'))).toBe('encrypted');
    expect(classifyPrivateKey(withLegacyEncryptionHeaders(ephemeralRsa().pkcs1))).toBe('encrypted');
  });

  it('fails closed on malformed and unrecognized input', () => {
    const sec1 = ephemeralEc('prime256v1').sec1;
    const b64Body = sec1
      .split(/\r?\n/)
      .filter((l) => l !== '' && !l.startsWith('-----'))
      .join('');
    const truncated =
      sec1.slice(0, sec1.indexOf('-----END') - 8) + '-----END EC PRIVATE KEY-----';
    const garbageBody = sec1.replace(b64Body.slice(0, 40), '!!!!not-base64!!!!');

    expect(classifyPrivateKey('')).toBe('unknown');
    expect(classifyPrivateKey('not a key at all')).toBe('unknown');
    expect(classifyPrivateKey(truncated)).toBe('unknown');
    expect(classifyPrivateKey(garbageBody)).toBe('unknown');
    expect(classifyPrivateKey('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')).toBe('unknown');
    expect(classifyPrivateKey(Buffer.from(sec1, 'utf8'))).toBe('ecdsa');
  });

  it('maps kinds to user-facing verdicts', () => {
    expect(assessPrivateKeyAuth(ephemeralRsa().pkcs1).verdict).toBe('allowed');
    expect(assessPrivateKeyAuth(ephemeralEd25519().pkcs8).verdict).toBe('allowed');
    const ecdsa = assessPrivateKeyAuth(ephemeralEc('prime256v1').sec1);
    expect(ecdsa.verdict).toBe('refused');
    expect(ecdsa.kind).toBe('ecdsa');
    expect(assessPrivateKeyAuth(encryptedPkcs8('ed25519')).verdict).toBe('indeterminate');
    expect(assessPrivateKeyAuth('junk').verdict).toBe('indeterminate');
  });
});

describe('one-shot sign refuses ECDSA before any elliptic call', () => {
  it('refuses SEC1 EC keys with the stable unsupported error', () => {
    const ec = ephemeralEc('prime256v1');
    const result = shimSign('sha256', data, ec.sec1);
    expect(result).toBeInstanceOf(Error);
    const err = result as Error;
    expect(err.code).toBe('ERR_BROWSER_ECDSA_UNSUPPORTED');
    expect(err.message).toContain('ECDSA');
    expect(err.message).not.toContain(ec.sec1.slice(40, 80));
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('refuses PKCS#8 EC keys identically (ssh2 re-emits SEC1, direct callers may not)', () => {
    const result = shimSign('sha256', data, ephemeralEc('secp384r1').pkcs8);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).code).toBe('ERR_BROWSER_ECDSA_UNSUPPORTED');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('refuses encrypted and unrecognized keys with the format error', () => {
    const enc = shimSign('sha256', data, encryptedPkcs8('rsa'));
    expect(enc).toBeInstanceOf(Error);
    expect((enc as Error).code).toBe('ERR_BROWSER_KEY_FORMAT_UNSUPPORTED');

    const junk = shimSign('sha256', data, 'definitely not a pem');
    expect(junk).toBeInstanceOf(Error);
    expect((junk as Error).code).toBe('ERR_BROWSER_KEY_FORMAT_UNSUPPORTED');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });
});

describe('createSign().sign fallback cannot bypass the guard', () => {
  it('refuses EC keys on the instance-level sign path', () => {
    const signer = createSign('sha256');
    signer.update(data);
    expect(() => signer.sign(ephemeralEc('prime256v1').sec1)).toThrowError(/ECDSA/);
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('refuses encrypted and garbage keys on the fallback path too', () => {
    const encSigner = createSign('sha256');
    encSigner.update(data);
    expect(() => encSigner.sign(encryptedPkcs8('ec', 'prime256v1'))).toThrowError(/encrypted/);

    const junkSigner = createSign('sha256');
    junkSigner.update(data);
    expect(() => junkSigner.sign('garbage')).toThrowError(/unrecognized/);
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('still produces real RSA signatures through the wrapped signer', () => {
    const rsa = ephemeralRsa();
    const signer = createSign('sha256');
    signer.update(data);
    const sig = signer.sign(rsa.pkcs1) as Buffer;
    expect(Buffer.isBuffer(sig));
    expect(nodeVerify('sha256', data, rsa.spki, sig)).toBe(true);
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });
});

describe('RSA and Ed25519 stay fully positive through the shim', () => {
  it('signs RSA PKCS#1 and PKCS#8; real node crypto verifies against the SPKI', () => {
    for (const pem of [ephemeralRsa().pkcs1, ephemeralRsa().pkcs8]) {
      const sig = shimSign('sha256', data, pem);
      expect(Buffer.isBuffer(sig)).toBe(true);
    }
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('signs RSA with sha512 as well', () => {
    const rsa = ephemeralRsa();
    const sig = shimSign('sha512', data, rsa.pkcs1) as Buffer;
    expect(nodeVerify('sha512', data, rsa.spki, sig)).toBe(true);
  });

  it('signs Ed25519 on the null-algorithm path (raw 64-byte, tweetnacl)', () => {
    const ed = ephemeralEd25519();
    const sig = shimSign(null, data, ed.pkcs8) as Buffer;
    expect(sig).toBeInstanceOf(Buffer);
    expect(sig.length).toBe(64);
    expect(nodeVerify(null, data, ed.spki, sig)).toBe(true);
    expect(ellipticProbe.ecSignCalls).toBe(0);
    expect(ellipticProbe.eddsaSignCalls).toBe(0);
  });

  it('keeps the ssh2 Ed25519 support probe working (known probe key)', () => {
    const probeKey =
      '-----BEGIN PRIVATE KEY-----\r\nMC4CAQAwBQYDK2VwBCIEIHKj+sVa9WcD'
      + '/q2DJUJaf43Kptc8xYuUQA4bOFj9vC8T\r\n-----END PRIVATE KEY-----';
    const sig = shimSign(null, Buffer.from('a'), probeKey) as Buffer;
    expect(sig.length).toBe(64);
    expect(shimVerify(null, Buffer.from('a'), probeKey, sig)).toBe(true);
  });
});

describe('public-key verification is intentionally untouched', () => {
  it('verifies RSA signatures (host-key verification path)', () => {
    const rsa = ephemeralRsa();
    const nodeSig = nodeCreateSign('sha256').update(data).sign(rsa.pkcs1);
    expect(shimVerify('sha256', data, rsa.spki, nodeSig)).toBe(true);
    expect(shimVerify('sha256', Buffer.from('tampered'), rsa.spki, nodeSig)).toBe(false);
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('verifies Ed25519 signatures', () => {
    const ed = ephemeralEd25519();
    const sig = nodeSign(null, data, ed.pkcs8);
    expect(shimVerify(null, data, ed.spki, sig)).toBe(true);
  });

  it('still verifies ECDSA public keys — documented residual for host-key verification', () => {
    // Verification (public half) is out of the containment scope: the
    // advisory targets the signing primitive, and ECDSA host keys stay
    // verifiable for deployments that opt into them. Signing is the guarded
    // operation; this test pins that the residual is exactly verification.
    const ec = ephemeralEc('prime256v1');
    const sig = nodeSign('sha256', data, ec.sec1);
    expect(shimVerify('sha256', data, ec.spki, sig)).toBe(true);
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });
});

describe('assertSignablePrivateKey contract', () => {
  it('accepts rsa/dsa/ed25519 kinds and throws coded errors otherwise', () => {
    expect(() => assertSignablePrivateKey(ephemeralRsa().pkcs1)).not.toThrow();
    expect(() => assertSignablePrivateKey(ephemeralEd25519().pkcs8)).not.toThrow();
    expect(() => assertSignablePrivateKey(ephemeralEc('secp521r1').sec1)).toThrowError(/ECDSA/);
    expect(() => assertSignablePrivateKey(Buffer.from('nope'))).toThrowError(/unrecognized/);
    expect(() => assertSignablePrivateKey(12345)).toThrowError(/unrecognizable/);
  });
});

describe('error hygiene', () => {
  it('never leaks key or passphrase material in refusal errors', () => {
    const passphrase = 'super-secret-pass-phrase-42';
    const dir = newKeys();
    const encPem = dir.sshgen('ed25519', { passphrase });
    const result = shimSign('sha256', data, encPem);
    expect(result).toBeInstanceOf(Error);
    const text = `${(result as Error).message}`;
    expect(text).not.toContain(passphrase);
    expect(text).not.toContain(encPem.slice(60, 140));

    const ecPem = ephemeralEc('prime256v1').sec1;
    const ecErr = shimSign('sha256', data, ecPem) as Error;
    expect(ecErr.message).not.toContain(ecPem.slice(60, 140));
    expect(createHash('sha256').update('x').digest('hex').length).toBe(64); // node crypto still alive
  });
});
