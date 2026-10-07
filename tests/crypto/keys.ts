/**
 * Ephemeral key fixtures for the crypto containment suites. Two sources:
 *  - ssh-keygen for real OpenSSH-container keys (the format users actually
 *    store; encrypted variants use bcrypt KDF exactly like production),
 *  - node:crypto generateKeyPairSync for the DER PEM forms (PKCS#1/SEC1/
 *    PKCS#8, PBES2-encrypted) ssh2's parser and browserify-sign consume.
 * Everything lives in a per-suite temp dir and is deleted afterwards — no
 * real user keys are ever read.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

export class KeyDir {
  readonly dir: string;

  constructor(prefix: string) {
    this.dir = mkdtempSync(join(tmpdir(), `ps-crypto-${prefix}-`));
  }

  /** Generate with ssh-keygen (OpenSSH container format) and return the PEM. */
  sshgen(type: 'ed25519' | 'ecdsa' | 'rsa', opts: { bits?: number; passphrase?: string } = {}): string {
    const path = join(this.dir, `${type}-${opts.bits ?? 'd'}-${opts.passphrase ? 'enc' : 'plain'}`);
    execFileSync('ssh-keygen', [
      '-t', type,
      ...(opts.bits ? ['-b', String(opts.bits)] : []),
      '-N', opts.passphrase ?? '',
      '-q',
      '-C', 'ps-crypto-suite',
      '-f', path,
    ]);
    return readFileSync(path, 'utf8');
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Fresh ephemeral RSA key + its PKCS#1 / PKCS#8 private and SPKI public PEMs. */
export function ephemeralRsa(bits = 2048) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return {
    pkcs1: privateKey.export({ format: 'pem', type: 'pkcs1' }).toString(),
    pkcs8: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    spki: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

/** PBES2-encrypted PKCS#8 PEM (BEGIN ENCRYPTED PRIVATE KEY). */
export function encryptedPkcs8(kind: 'rsa' | 'ec' | 'ed25519', curve?: string, passphrase = 'pbes2-pass'): string {
  const keyPair =
    kind === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : kind === 'ec'
        ? generateKeyPairSync('ec', { namedCurve: curve ?? 'prime256v1' })
        : generateKeyPairSync('ed25519');
  return keyPair.privateKey
    .export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase })
    .toString();
}

/** Fresh ephemeral EC key + SEC1 / PKCS#8 private and SPKI public PEMs. */
export function ephemeralEc(namedCurve: 'prime256v1' | 'secp384r1' | 'secp521r1') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve });
  return {
    sec1: privateKey.export({ format: 'pem', type: 'sec1' }).toString(),
    pkcs8: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    spki: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

export function ephemeralEd25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pkcs8: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    spki: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

/** Legacy OpenSSL DEK-Info fragment: real PKCS#1 body, headers claim the
 * fragmentation/encryption markers ssh2's legacy parser looks for. Used to
 * prove the classifier refuses ciphertext-headered keys without ever
 * touching the DER. */
export function withLegacyEncryptionHeaders(pkcs1Pem: string): string {
  const lines = pkcs1Pem.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.startsWith('-----BEGIN'));
  lines.splice(begin + 1, 0, 'Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF');
  return lines.join('\n');
}
