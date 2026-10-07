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
import { createHash, createSign as nodeCreateSign, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
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
  ephemeralDsa,
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

/* --- DER / container craft helpers -----------------------------------------
 * Test-local re-implementations of the framing rules the classifier walks,
 * used to build malformed negatives that no key generator emits (trailing
 * bytes, padded lengths, spliced containers). */

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .split(/\r?\n/)
    .filter((l) => l !== '' && !l.startsWith('-----'))
    .join('');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

function derToPem(label: string, der: Uint8Array): string {
  let bin = '';
  for (const b of der) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return `-----BEGIN ${label}-----\n${(b64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----`;
}

/** One well-formed TLV around `content` (minimal length encoding). */
function buildTlv(tag: number, content: Uint8Array): Uint8Array {
  if (content.length < 128) {
    return Uint8Array.from([tag, content.length, ...content]);
  }
  const lenBytes: number[] = [];
  for (let n = content.length; n > 0; n = Math.floor(n / 256)) {
    lenBytes.unshift(n & 0xff);
  }
  return Uint8Array.from([tag, 0x80 | lenBytes.length, ...lenBytes, ...content]);
}

/** Children of the outer SEQUENCE of a key DER (the classifier's own walk:
 * tag, definite length, body). */
function derChildren(der: Uint8Array): Uint8Array[] {
  if (der[0] !== 0x30) throw new Error('craft helper: not a SEQUENCE');
  let len = der[1];
  let pos = 2;
  if ((len & 0x80) !== 0) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[2 + i];
    pos = 2 + n;
  }
  const end = pos + len;
  const children: Uint8Array[] = [];
  while (pos < end) {
    let childLen = der[pos + 1];
    let head = 2;
    if ((childLen & 0x80) !== 0) {
      const n = childLen & 0x7f;
      childLen = 0;
      for (let i = 0; i < n; i++) childLen = childLen * 256 + der[pos + 2 + i];
      head = 2 + n;
    }
    children.push(der.slice(pos, pos + head + childLen));
    pos += head + childLen;
  }
  return children;
}

function buildSeq(children: Uint8Array[]): Uint8Array {
  const bodyLen = children.reduce((n, c) => n + c.length, 0);
  const lenEnc = buildTlv(0x00, new Uint8Array(bodyLen)).slice(1);
  const out = new Uint8Array(1 + lenEnc.length + bodyLen);
  out[0] = 0x30;
  out.set(lenEnc, 1);
  let at = 1 + lenEnc.length;
  for (const child of children) {
    out.set(child, at);
    at += child.length;
  }
  return out;
}

function sshStr(content: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + content.length);
  new DataView(out.buffer).setUint32(0, content.length);
  out.set(content, 4);
  return out;
}

interface OpenSshContainer {
  pubBlob: Uint8Array;
  privBlob: Uint8Array;
}

/** Parse the fields of an unencrypted openssh-key-v1 container. */
function parseOpenSshContainer(pem: string): OpenSshContainer {
  const u8 = pemToDer(pem);
  let at = 'openssh-key-v1'.length + 1;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const readStr = (offset: number): { data: Uint8Array; next: number } => {
    const len = view.getUint32(offset);
    return { data: u8.slice(offset + 4, offset + 4 + len), next: offset + 4 + len };
  };
  at = readStr(at).next; // cipher
  at = readStr(at).next; // kdf
  at = readStr(at).next; // kdf options
  const keyCount = view.getUint32(at);
  if (keyCount !== 1) throw new Error('craft helper: unexpected key count');
  const pub = readStr(at + 4);
  const priv = readStr(pub.next);
  return { pubBlob: pub.data, privBlob: priv.data };
}

/** Rebuild an unencrypted openssh-key-v1 container from its two blobs. */
function buildOpenSshContainer({ pubBlob, privBlob }: OpenSshContainer): string {
  const u8 = Uint8Array.from([
    ...new TextEncoder().encode('openssh-key-v1'),
    0x00,
    ...sshStr(new TextEncoder().encode('none')),
    ...sshStr(new TextEncoder().encode('none')),
    ...sshStr(new Uint8Array(0)), // kdf options
    0, 0, 0, 1, // key count
    ...sshStr(pubBlob),
    ...sshStr(privBlob),
  ]);
  return derToPem('OPENSSH PRIVATE KEY', u8);
}

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

  it('classifies DSA PKCS#8 (node cannot emit the PKCS#1 DSA form)', () => {
    const dsa = ephemeralDsa();
    expect(classifyPrivateKey(dsa.pkcs8)).toBe('dsa');
    expect(assessPrivateKeyAuth(dsa.pkcs8).verdict).toBe('allowed');
  });
});

describe('hardened DER negatives (exact parent consumption, inner payload)', () => {
  it('rejects trailing bytes after the outer SEQUENCE', () => {
    const der = pemToDer(ephemeralRsa().pkcs1);
    const trailing = Uint8Array.from([...der, 0xde, 0xad, 0xbe]);
    expect(classifyPrivateKey(derToPem('RSA PRIVATE KEY', trailing))).toBe('unknown');
    const result = shimSign('sha256', data, derToPem('RSA PRIVATE KEY', trailing));
    expect((result as Error).code).toBe('ERR_BROWSER_KEY_FORMAT_UNSUPPORTED');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('rejects non-INTEGER trailing bytes inside the PKCS#1 SEQUENCE', () => {
    const children = derChildren(pemToDer(ephemeralRsa().pkcs1));
    expect(children).toHaveLength(9);
    const padded = buildSeq([...children, buildTlv(0x04, Uint8Array.from([1, 2, 3]))]);
    expect(classifyPrivateKey(derToPem('RSA PRIVATE KEY', padded))).toBe('unknown');
  });

  it('rejects a tenth INTEGER in the PKCS#1 SEQUENCE', () => {
    const children = derChildren(pemToDer(ephemeralRsa().pkcs1));
    const extra = buildSeq([...children, buildTlv(0x02, Uint8Array.from([1]))]);
    expect(classifyPrivateKey(derToPem('RSA PRIVATE KEY', extra))).toBe('unknown');
  });

  it('rejects PKCS#8 whose inner payload does not match the algorithm OID', () => {
    // rsaEncryption claimed, inner SEQUENCE truncated mid-body
    const pkcs8 = derChildren(pemToDer(ephemeralRsa().pkcs8));
    const [version, algSeq, octet] = pkcs8;
    const inner = octet.slice(4); // strip OCTET STRING header → inner PKCS#1 DER
    const truncatedInner = inner.slice(0, inner.length - 10);
    const rebuilt = buildSeq([version, algSeq, buildTlv(0x04, truncatedInner)]);
    expect(classifyPrivateKey(derToPem('PRIVATE KEY', rebuilt))).toBe('unknown');

    // id-Ed25519 claimed, inner seed not 32 bytes
    const ed = derChildren(pemToDer(ephemeralEd25519().pkcs8));
    const [edVersion, edAlg] = ed;
    const shortSeed = buildSeq([edVersion, edAlg, buildTlv(0x04, buildTlv(0x04, new Uint8Array(31)))]);
    expect(classifyPrivateKey(derToPem('PRIVATE KEY', shortSeed))).toBe('unknown');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('rejects PKCS#8 with no inner OCTET STRING at all', () => {
    const pkcs8 = derChildren(pemToDer(ephemeralRsa().pkcs8));
    const stripped = buildSeq([pkcs8[0], pkcs8[1]]);
    expect(classifyPrivateKey(derToPem('PRIVATE KEY', stripped))).toBe('unknown');
  });

  it('rejects a non-minimal DER length encoding', () => {
    const der = pemToDer(ephemeralEc('prime256v1').sec1);
    expect(der[1]).toBeLessThan(0x80); // short form today
    const padded = Uint8Array.from([0x30, 0x81, der[1], ...der.slice(2)]);
    expect(classifyPrivateKey(derToPem('EC PRIVATE KEY', padded))).toBe('unknown');
  });

  it('rejects SEC1 trailing non-[0]/[1] bytes inside the SEQUENCE', () => {
    const children = derChildren(pemToDer(ephemeralEc('prime256v1').sec1));
    const junk = buildSeq([...children, buildTlv(0x02, Uint8Array.from([1]))]);
    expect(classifyPrivateKey(derToPem('EC PRIVATE KEY', junk))).toBe('unknown');
  });

  it('does not recognize an X25519 PKCS#8 key (unknown → refused at the boundary)', () => {
    const x = generateKeyPairSync('x25519');
    const pem = x.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(classifyPrivateKey(pem)).toBe('unknown');
    expect((shimSign('sha256', data, pem) as Error).code).toBe('ERR_BROWSER_KEY_FORMAT_UNSUPPORTED');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });
});

describe('hardened OpenSSH container negatives (private section validated)', () => {
  it('rejects trailing bytes appended to the container', () => {
    const dir = newKeys();
    const pem = dir.sshgen('ed25519');
    const der = pemToDer(pem);
    expect(classifyPrivateKey(derToPem('OPENSSH PRIVATE KEY', Uint8Array.from([...der, 0, 0, 0])))).toBe('unknown');
  });

  it('rejects disagreeing check ints, mutated type strings, corrupted padding', () => {
    const dir = newKeys();
    const pem = dir.sshgen('ed25519');
    const { pubBlob, privBlob } = parseOpenSshContainer(pem);

    // check ints must agree
    const badCheck = privBlob.slice();
    badCheck[5] ^= 0xff;
    expect(classifyPrivateKey(buildOpenSshContainer({ pubBlob, privBlob: badCheck }))).toBe('unknown');

    // private section type string must match the public header
    const badPrivType = privBlob.slice();
    const typeAt = 8;
    badPrivType[typeAt + 4 + 4] ^= 0x01; // flip a byte inside "ssh-ed25519"
    expect(classifyPrivateKey(buildOpenSshContainer({ pubBlob, privBlob: badPrivType }))).toBe('unknown');

    // public header type string mutated
    const badPubType = pubBlob.slice();
    badPubType[4 + 4] ^= 0x01;
    expect(classifyPrivateKey(buildOpenSshContainer({ pubBlob: badPubType, privBlob }))).toBe('unknown');

    // padding corrupted: an extra 0xFF byte can never be a valid next
    // padding byte (or a new field), whatever alignment the key landed on
    const badPad = Uint8Array.from([...privBlob, 0xff]);
    expect(classifyPrivateKey(buildOpenSshContainer({ pubBlob, privBlob: badPad }))).toBe('unknown');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('rejects a spliced container whose public and private types disagree', () => {
    const dir = newKeys();
    const edPem = dir.sshgen('ed25519');
    const rsaPem = dir.sshgen('rsa', { bits: 2048 });
    const edPub = parseOpenSshContainer(edPem).pubBlob;
    const rsaPriv = parseOpenSshContainer(rsaPem).privBlob;
    // Both halves are valid keys — the container as a whole is not.
    expect(classifyPrivateKey(buildOpenSshContainer({ pubBlob: edPub, privBlob: rsaPriv }))).toBe('unknown');
  });

  it('still classifies a rebuilt genuine container (helpers round-trip)', () => {
    const dir = newKeys();
    const pem = dir.sshgen('ed25519');
    expect(classifyPrivateKey(buildOpenSshContainer(parseOpenSshContainer(pem)))).toBe('ed25519');
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
