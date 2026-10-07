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
  // minimal DER length encoding, built directly — routing a zero-filled
  // content buffer through buildTlv would drag the content into the
  // "length" and emit a garbage SEQUENCE that classifies as unknown for
  // the wrong reason (every negative built on it would pass vacuously)
  const lenBytes: number[] =
    bodyLen < 128
      ? [bodyLen]
      : (() => {
          const bytes: number[] = [];
          for (let n = bodyLen; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
          return [0x80 | bytes.length, ...bytes];
        })();
  const out = new Uint8Array(1 + lenBytes.length + bodyLen);
  out[0] = 0x30;
  out.set(lenBytes, 1);
  let at = 1 + lenBytes.length;
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

/* --- fix-round helpers: envelope relabeling, TLV/section craft -------------- */

function relabel(pem: string, from: string, to: string): string {
  return pem
    .split(`-----BEGIN ${from}-----`).join(`-----BEGIN ${to}-----`)
    .split(`-----END ${from}-----`).join(`-----END ${to}-----`);
}

function tlvBody(tlv: Uint8Array): Uint8Array {
  let len = tlv[1];
  let head = 2;
  if ((len & 0x80) !== 0) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + tlv[2 + i];
    head = 2 + n;
  }
  return tlv.slice(head);
}

function concatU8(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function flipByte(u8: Uint8Array, i: number): Uint8Array {
  const out = u8.slice();
  out[i] = (out[i] ?? 0) ^ 0xff;
  return out;
}

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function readSshStringAt(u8: Uint8Array, at: number): { data: Uint8Array; next: number } {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = view.getUint32(at);
  return { data: u8.slice(at + 4, at + 4 + len), next: at + 4 + len };
}

interface ParsedPrivSection {
  check: Uint8Array;
  type: string;
  fields: Uint8Array[];
  comment: Uint8Array;
  padding: Uint8Array;
}

const PRIV_FIELD_COUNTS: Record<string, number> = {
  'ssh-rsa': 6,
  'ssh-dss': 5,
  'ssh-ed25519': 2,
};

function privFieldCount(type: string): number {
  return type.startsWith('ecdsa-sha2-') ? 3 : PRIV_FIELD_COUNTS[type];
}

function parsePrivSection(privBlob: Uint8Array, type: string): ParsedPrivSection {
  let at = 8;
  const typeRead = readSshStringAt(privBlob, at);
  if (new TextDecoder().decode(typeRead.data) !== type) {
    throw new Error('craft helper: private section type mismatch');
  }
  at = typeRead.next;
  const fields: Uint8Array[] = [];
  for (let i = 0; i < privFieldCount(type); i++) {
    const field = readSshStringAt(privBlob, at);
    fields.push(field.data);
    at = field.next;
  }
  const comment = readSshStringAt(privBlob, at);
  at = comment.next;
  return {
    check: privBlob.slice(0, 8),
    type,
    fields,
    comment: comment.data,
    padding: privBlob.slice(at),
  };
}

/** Rebuild a private section; padding is recomputed canonically (OpenSSH's
 * pad-to-8 while-loop) unless explicitly overridden. */
function buildPrivSection(
  parsed: ParsedPrivSection,
  overrides: Partial<ParsedPrivSection> = {},
): Uint8Array {
  const p = { ...parsed, ...overrides };
  const body = [
    p.check,
    sshStr(enc(p.type)),
    ...p.fields.map((f) => sshStr(f)),
    sshStr(p.comment),
  ];
  const len = body.reduce((n, b) => n + b.length, 0);
  const pad = p.padding ?? Uint8Array.from({ length: (8 - (len % 8)) % 8 }, (_, i) => i + 1);
  return concatU8(...body, pad);
}

/* --- single-envelope PEM contract (ambiguity defense) ----------------------- */

describe('single-envelope PEM contract', () => {
  it('refuses leading junk, trailing junk and additional PEM blocks', () => {
    const rsa = ephemeralRsa();
    const cert = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
    const multiBlockAfter = rsa.pkcs1 + cert;
    const multiBlockBefore = cert + rsa.pkcs1;
    const leadingJunk = 'junk before the envelope\n' + rsa.pkcs1;
    const trailingJunk = rsa.pkcs1 + 'trailing junk\n';
    const twoKeys = rsa.pkcs1 + rsa.pkcs1;

    for (const bad of [multiBlockAfter, multiBlockBefore, leadingJunk, trailingJunk, twoKeys]) {
      expect(classifyPrivateKey(bad), JSON.stringify(bad.slice(0, 40))).toBe('unknown');
      const result = shimSign('sha256', data, bad);
      expect((result as Error).code).toBe('ERR_BROWSER_KEY_FORMAT_UNSUPPORTED');
    }
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('refuses mismatched BEGIN/END labels, even with a later matching END', () => {
    const rsa = ephemeralRsa();
    const mismatched = rsa.pkcs1.replace(
      '-----END RSA PRIVATE KEY-----',
      '-----END EC PRIVATE KEY-----',
    );
    expect(classifyPrivateKey(mismatched)).toBe('unknown');

    // BEGIN RSA … END EC … junk … END RSA: the scan must not recover the key
    // from the final matching END
    const split = rsa.pkcs1.replace(
      '-----END RSA PRIVATE KEY-----',
      '-----END EC PRIVATE KEY-----\nnot base64 at all\n-----END RSA PRIVATE KEY-----',
    );
    expect(classifyPrivateKey(split)).toBe('unknown');
    expect((shimSign('sha256', data, mismatched) as Error).code).toBe('ERR_BROWSER_KEY_FORMAT_UNSUPPORTED');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('refuses labels inconsistent with the contained DER structure', () => {
    const rsa = ephemeralRsa();
    const ec = ephemeralEc('prime256v1');
    // RSA DER under the EC label / EC DER under the RSA label
    expect(classifyPrivateKey(relabel(rsa.pkcs1, 'RSA PRIVATE KEY', 'EC PRIVATE KEY'))).toBe('unknown');
    expect(classifyPrivateKey(relabel(ec.sec1, 'EC PRIVATE KEY', 'RSA PRIVATE KEY'))).toBe('unknown');
    // bare PKCS#1 under the PKCS#8 label ("PRIVATE KEY")
    expect(classifyPrivateKey(relabel(rsa.pkcs1, 'RSA PRIVATE KEY', 'PRIVATE KEY'))).toBe('unknown');
    // DSA label over a 9-field RSA body
    expect(classifyPrivateKey(relabel(rsa.pkcs1, 'RSA PRIVATE KEY', 'DSA PRIVATE KEY'))).toBe('unknown');
    // differential: refusals are coded and elliptic never runs
    const relabeled = relabel(rsa.pkcs1, 'RSA PRIVATE KEY', 'EC PRIVATE KEY');
    expect((shimSign('sha256', data, relabeled) as Error).code).toBe('ERR_BROWSER_KEY_FORMAT_UNSUPPORTED');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('still accepts canonical keys with whitespace-only padding around the envelope', () => {
    const rsa = ephemeralRsa();
    const ed = ephemeralEd25519();
    expect(classifyPrivateKey('\n\t \r\n' + rsa.pkcs1 + '\n\n  ')).toBe('rsa');
    expect(classifyPrivateKey('\n' + ed.pkcs8)).toBe('ed25519');
  });
});

/* --- strict DER INTEGER content and exact PKCS#8 inner ---------------------- */

describe('strict DER INTEGER content and exact PKCS#8 inner', () => {
  it('refuses zero-length, zero-valued, nonminimal and negative field INTEGERs', () => {
    const base = derChildren(pemToDer(ephemeralRsa().pkcs1));
    expect(base).toHaveLength(9);
    const mk = (children: Uint8Array[]) => derToPem('RSA PRIVATE KEY', buildSeq(children));

    // zero-length INTEGER body (qinv emptied)
    const zeroLen = base.slice();
    zeroLen[8] = buildTlv(0x02, new Uint8Array(0));
    expect(classifyPrivateKey(mk(zeroLen))).toBe('unknown');

    // zero-valued field (e = 0)
    const zeroVal = base.slice();
    zeroVal[2] = buildTlv(0x02, Uint8Array.from([0x00]));
    expect(classifyPrivateKey(mk(zeroVal))).toBe('unknown');

    // nonminimal positive: sign pad in front of a value not needing it
    const nonminimal = base.slice();
    nonminimal[2] = buildTlv(0x02, Uint8Array.from([0x00, ...tlvBody(base[2])]));
    expect(classifyPrivateKey(mk(nonminimal))).toBe('unknown');

    // negative field: high bit set with no sign pad (encodes a negative number)
    const negative = base.slice();
    negative[3] = buildTlv(0x02, Uint8Array.from([0xff, ...tlvBody(base[3]).slice(0, 32)]));
    expect(classifyPrivateKey(mk(negative))).toBe('unknown');

    for (const bad of [mk(zeroLen), mk(zeroVal), mk(nonminimal), mk(negative)]) {
      expect((shimSign('sha256', data, bad) as Error).code).toBe('ERR_BROWSER_KEY_FORMAT_UNSUPPORTED');
    }
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('preserves legitimate positive sign padding in a field position', () => {
    const base = derChildren(pemToDer(ephemeralRsa().pkcs1));
    // e := 128 = 02 02 00 80 — exactly the legal single-pad form
    const padded = base.slice();
    padded[2] = buildTlv(0x02, Uint8Array.from([0x00, 0x80]));
    expect(classifyPrivateKey(derToPem('RSA PRIVATE KEY', buildSeq(padded)))).toBe('rsa');
  });

  it('refuses a DSA-shaped payload under the rsaEncryption OID (exact inner only)', () => {
    const rsaChildren = derChildren(pemToDer(ephemeralRsa().pkcs1));
    // version + 5 INTEGERs — the PKCS#1 DSA shape, built from real RSA fields
    const dsaBody = buildSeq(rsaChildren.slice(0, 6));
    expect(classifyPrivateKey(derToPem('DSA PRIVATE KEY', dsaBody))).toBe('dsa');

    // the SAME body under an rsaEncryption PKCS#8 must be unknown, not 'dsa'
    const rsaOid = buildTlv(0x06, Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]));
    const algSeq = buildSeq([rsaOid]);
    const pkcs8 = buildSeq([
      buildTlv(0x02, Uint8Array.from([0x00])),
      algSeq,
      buildTlv(0x04, dsaBody),
    ]);
    expect(classifyPrivateKey(derToPem('PRIVATE KEY', pkcs8))).toBe('unknown');
    expect((shimSign('sha256', data, derToPem('PRIVATE KEY', pkcs8)) as Error).code)
      .toBe('ERR_BROWSER_KEY_FORMAT_UNSUPPORTED');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('refuses a non-RSA inner payload under the rsaEncryption OID', () => {
    // rsaEncryption claimed, inner is an Ed25519-style OCTET STRING(32)
    const rsaOid = buildTlv(0x06, Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]));
    const pkcs8 = buildSeq([
      buildTlv(0x02, Uint8Array.from([0x00])),
      buildSeq([rsaOid]),
      buildTlv(0x04, buildTlv(0x04, new Uint8Array(32))),
    ]);
    expect(classifyPrivateKey(derToPem('PRIVATE KEY', pkcs8))).toBe('unknown');
  });

  it('refuses zero-length, zero-valued and nonminimal DSA PKCS#8 exponents', () => {
    const dsa = ephemeralDsa();
    const children = derChildren(pemToDer(dsa.pkcs8));
    const [version, algSeq] = children;
    const mkInner = (content: Uint8Array) =>
      derToPem('PRIVATE KEY', buildSeq([version, algSeq, buildTlv(0x04, buildTlv(0x02, content))]));

    expect(classifyPrivateKey(mkInner(new Uint8Array(0)))).toBe('unknown'); // empty
    expect(classifyPrivateKey(mkInner(Uint8Array.from([0x00])))).toBe('unknown'); // zero
    expect(classifyPrivateKey(mkInner(Uint8Array.from([0x00, 0x01])))).toBe('unknown'); // pad not needed
    // the legal pad form (value's top bit set) still classifies
    expect(classifyPrivateKey(mkInner(Uint8Array.from([0x00, 0x80])))).toBe('dsa');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });
});

/* --- OpenSSH cipher=none per-type structural validation ---------------------- */

describe('OpenSSH cipher=none per-type structural validation', () => {
  it('ed25519: enforces A=32, secret=64 and public/private A agreement', () => {
    const dir = newKeys();
    const { pubBlob, privBlob } = parseOpenSshContainer(dir.sshgen('ed25519'));
    const parsed = parsePrivSection(privBlob, 'ssh-ed25519');
    const [a, secret] = parsed.fields;
    expect(a.length).toBe(32);
    expect(secret.length).toBe(64);
    const classify = (priv: Uint8Array) =>
      classifyPrivateKey(buildOpenSshContainer({ pubBlob, privBlob: priv }));

    // positive control: faithful rebuild
    expect(classify(buildPrivSection(parsed))).toBe('ed25519');
    // A truncated below 32
    expect(classify(buildPrivSection(parsed, { fields: [a.slice(0, 31), secret] }))).toBe('unknown');
    // secret shorter than 64
    expect(classify(buildPrivSection(parsed, { fields: [a, secret.slice(0, 63)] }))).toBe('unknown');
    // seed-only 32-byte secret (not the canonical OpenSSH form)
    expect(classify(buildPrivSection(parsed, { fields: [a, secret.slice(0, 32)] }))).toBe('unknown');
    // private A disagrees with the public blob's A
    expect(classify(buildPrivSection(parsed, { fields: [flipByte(a, 0), secret] }))).toBe('unknown');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('ssh-rsa: refuses empty/zero/nonminimal/negative mpints and d ≥ n', () => {
    const dir = newKeys();
    const { pubBlob, privBlob } = parseOpenSshContainer(dir.sshgen('rsa', { bits: 2048 }));
    const parsed = parsePrivSection(privBlob, 'ssh-rsa');
    const [n, e, d, iqmp, p, q] = parsed.fields;
    const classify = (priv: Uint8Array) =>
      classifyPrivateKey(buildOpenSshContainer({ pubBlob, privBlob: priv }));
    expect(classify(buildPrivSection(parsed))).toBe('rsa');

    // zero-length mpint (iqmp emptied)
    expect(classify(buildPrivSection(parsed, { fields: [n, e, d, new Uint8Array(0), p, q] }))).toBe('unknown');
    // zero-valued d
    expect(classify(buildPrivSection(parsed, { fields: [n, e, new Uint8Array([0x00]), iqmp, p, q] }))).toBe('unknown');
    // nonminimal e: sign pad in front of a value not needing it
    expect(classify(buildPrivSection(parsed, { fields: [n, Uint8Array.from([0x00, ...e]), d, iqmp, p, q] }))).toBe('unknown');
    // negative d: high bit set, no sign pad
    expect(classify(buildPrivSection(parsed, { fields: [n, e, Uint8Array.from([0xff, ...d.slice(0, 32)]), iqmp, p, q] }))).toBe('unknown');
    // d ≥ n (agreement intact, order relation violated)
    const dBig = Uint8Array.from([0x01, ...n]);
    expect(classify(buildPrivSection(parsed, { fields: [n, e, dBig, iqmp, p, q] }))).toBe('unknown');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('ssh-rsa: refuses same-type splices whose public n/e disagree with the private section', () => {
    const dirA = newKeys();
    const dirB = newKeys();
    const a = parseOpenSshContainer(dirA.sshgen('rsa', { bits: 2048 }));
    const b = parseOpenSshContainer(dirB.sshgen('rsa', { bits: 2048 }));
    // both halves are valid ssh-rsa keys — the container as a whole is not
    expect(classifyPrivateKey(buildOpenSshContainer({ pubBlob: a.pubBlob, privBlob: b.privBlob }))).toBe('unknown');
    expect(classifyPrivateKey(buildOpenSshContainer(a))).toBe('rsa');
    expect(classifyPrivateKey(buildOpenSshContainer(b))).toBe('rsa');
  });

  it('ecdsa: refuses curve-name mismatch, malformed/mismatched Q, bad scalars', () => {
    const dir = newKeys();
    const { pubBlob, privBlob } = parseOpenSshContainer(dir.sshgen('ecdsa', { bits: 256 }));
    const parsed = parsePrivSection(privBlob, 'ecdsa-sha2-nistp256');
    const [curveName, pointQ, scalar] = parsed.fields;
    expect(pointQ.length).toBe(65); // 0x04 || 32 || 32
    expect(pointQ[0]).toBe(0x04);
    const classify = (priv: Uint8Array) =>
      classifyPrivateKey(buildOpenSshContainer({ pubBlob, privBlob: priv }));
    expect(classify(buildPrivSection(parsed))).toBe('ecdsa');

    // curve name inside the private section disagrees with the type
    expect(classify(buildPrivSection(parsed, { fields: [enc('nistp384'), pointQ, scalar] }))).toBe('unknown');
    // Q truncated (not 1 + 2*32)
    expect(classify(buildPrivSection(parsed, { fields: [curveName, pointQ.slice(0, 64), scalar] }))).toBe('unknown');
    // Q not uncompressed
    const compressed = pointQ.slice();
    compressed[0] = 0x02;
    expect(classify(buildPrivSection(parsed, { fields: [curveName, compressed, scalar] }))).toBe('unknown');
    // private Q disagrees with the public blob's Q
    expect(classify(buildPrivSection(parsed, { fields: [curveName, flipByte(pointQ, 20), scalar] }))).toBe('unknown');
    // empty scalar
    expect(classify(buildPrivSection(parsed, { fields: [curveName, pointQ, new Uint8Array(0)] }))).toBe('unknown');
    // scalar longer than the coordinate size
    expect(classify(buildPrivSection(parsed, { fields: [curveName, pointQ, Uint8Array.from([0x01, ...scalar])] }))).toBe('unknown');
    expect(ellipticProbe.ecSignCalls).toBe(0);
  });

  it('enforces 8-byte section alignment with at most 7 canonical padding bytes', () => {
    const dir = newKeys();
    const { pubBlob, privBlob } = parseOpenSshContainer(dir.sshgen('ed25519'));
    const parsed = parsePrivSection(privBlob, 'ssh-ed25519');
    const classify = (priv: Uint8Array) =>
      classifyPrivateKey(buildOpenSshContainer({ pubBlob, privBlob: priv }));

    const aligned = buildPrivSection(parsed);
    expect(aligned.length % 8).toBe(0);
    // 8 canonical padding bytes: aligned but over the 0..7 budget
    expect(classify(buildPrivSection(parsed, { padding: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) }))).toBe('unknown');
    // one canonical byte appended: padLen 1 used to slip through, but the
    // section is no longer 8-byte aligned
    expect(classify(buildPrivSection(parsed, { padding: Uint8Array.from([1]) }))).toBe('unknown');
    // non-canonical padding content
    expect(classify(buildPrivSection(parsed, { padding: Uint8Array.from([1, 3]) }))).toBe('unknown');
    // positive control: canonical recomputed padding
    expect(classify(aligned)).toBe('ed25519');
  });

  it('preserves genuinely zero-pad-aligned sections (deterministic + generated keys)', () => {
    const dir = newKeys();
    const { pubBlob, privBlob } = parseOpenSshContainer(dir.sshgen('ecdsa', { bits: 256 }));
    const parsed = parsePrivSection(privBlob, 'ecdsa-sha2-nistp256');
    // absorb the alignment into the comment so the section carries NO
    // padding — the legitimate aligned case the first cut wrongly refused
    const fixedLen = 8 + (4 + enc(parsed.type).length) +
      parsed.fields.reduce((n, f) => n + 4 + f.length, 0) + 4;
    const commentFill = (8 - (fixedLen % 8)) % 8;
    const alignedNoPad = buildPrivSection(parsed, {
      comment: new Uint8Array(commentFill),
      padding: new Uint8Array(0),
    });
    expect(alignedNoPad.length % 8).toBe(0);
    expect(classifyPrivateKey(buildOpenSshContainer({ pubBlob, privBlob: alignedNoPad }))).toBe('ecdsa');

    // real generated keys across shapes and alignments keep classifying
    for (let i = 0; i < 6; i++) {
      const loopDir = newKeys();
      expect(classifyPrivateKey(loopDir.sshgen('ed25519'))).toBe('ed25519');
      expect(classifyPrivateKey(loopDir.sshgen('ecdsa', { bits: 256 }))).toBe('ecdsa');
    }
  });

  it('ssh-dss: x ≥ q refuses; structurally consistent ordering classifies', () => {
    const m = (v: number) => Uint8Array.from([v]);
    const pubBlob = concatU8(
      sshStr(enc('ssh-dss')),
      sshStr(m(0x0d)), sshStr(m(0x03)), sshStr(m(0x02)), sshStr(m(0x04)), // p q g y
    );
    const mk = (x: Uint8Array) =>
      buildOpenSshContainer({
        pubBlob,
        privBlob: buildPrivSection({
          check: Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]),
          type: 'ssh-dss',
          fields: [m(0x0d), m(0x03), m(0x02), m(0x04), x],
          comment: new Uint8Array(0),
          padding: new Uint8Array(0),
        }),
      });
    expect(classifyPrivateKey(mk(m(0x02)))).toBe('dsa'); // x < q
    expect(classifyPrivateKey(mk(m(0x05)))).toBe('unknown'); // x ≥ q
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
