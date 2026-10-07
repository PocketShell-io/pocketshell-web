/**
 * Structural classification of SSH private-key PEM forms — without executing
 * any key-dependent crypto. The browser signing guard must decide what a key
 * IS before browserify-sign (and behind it elliptic) ever receives it; once
 * the vulnerable ECDSA signer runs, it is too late to contain.
 *
 * The PEMs that reach the signing boundary come from ssh2's key parser
 * (ssh2/lib/protocol/keyParser.js), which re-serializes every container it
 * accepts — OpenSSH, legacy "BEGIN x PRIVATE KEY" (optionally decrypted),
 * PPK — into OpenSSL PEMs: PKCS#1 RSA/DSA, SEC1 EC, PKCS#8 Ed25519. The
 * classifier also reads the raw OpenSSH container itself so an early
 * user-facing check can judge the key exactly as the user stored it, before
 * ssh2 has converted or decrypted anything.
 *
 * Deliberately dependency-free: no ASN.1 library, no elliptic, no ssh2
 * import — an ssh2 -> shim -> ssh2 cycle is exactly what this must not
 * create, and the DER walk below (definite lengths only, every read bounds
 * checked) is the whole parser. Anything that does not match a recognized
 * structure classifies as "unknown"; callers fail closed on "unknown".
 */

export type PrivateKeyKind =
  | 'rsa'
  | 'dsa'
  | 'ecdsa'
  | 'ed25519'
  | 'encrypted'
  | 'unknown';

/** 'allowed' — the browser build signs with it; 'refused' — never (ECDSA);
 * 'indeterminate' — this form alone cannot say (ssh2 may still decrypt or
 * convert it into a decidable PEM before signing). */
export type PrivateKeyVerdict = 'allowed' | 'refused' | 'indeterminate';

export interface PrivateKeyAssessment {
  kind: PrivateKeyKind;
  verdict: PrivateKeyVerdict;
  /** Stable, non-secret explanation — safe to surface to users. Never
   * contains key or passphrase material. */
  reason: string;
}

/* --- minimal DER walk ------------------------------------------------------ */

interface DerSpan {
  bodyStart: number;
  bodyEnd: number;
  next: number;
}

/** Read one definite-length primitive/constructed TLV and require an exact
 * tag byte. Long-form lengths are accepted up to 4 bytes; indefinite (0x80)
 * and oversized forms return null — a truncated or exotic encoding must
 * classify as unknown, not crash. */
function derExpect(
  u8: Uint8Array,
  offset: number,
  tag: number,
): DerSpan | null {
  if (offset + 2 > u8.length) return null;
  if (u8[offset] !== tag) return null;
  let len = u8[offset + 1];
  let pos = offset + 2;
  if ((len & 0x80) !== 0) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || pos + n > u8.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + u8[pos + i];
    pos += n;
  }
  if (pos + len > u8.length) return null;
  return { bodyStart: pos, bodyEnd: pos + len, next: pos + len };
}

function readOid(u8: Uint8Array, start: number, end: number): string | null {
  const parts: number[] = [];
  let val = 0;
  let pending = false;
  for (let i = start; i < end; i++) {
    const b = u8[i];
    if (val > Number.MAX_SAFE_INTEGER / 128) return null;
    val = val * 128 + (b & 0x7f);
    pending = true;
    if ((b & 0x80) === 0) {
      if (parts.length === 0) {
        parts.push(Math.min(Math.floor(val / 40), 2));
        parts.push(val - parts[0] * 40);
      } else {
        parts.push(val);
      }
      val = 0;
      pending = false;
    }
  }
  if (pending) return null; // truncated final arc
  return parts.join('.');
}

function readU32be(u8: Uint8Array, at: number): number {
  return (
    ((u8[at] << 24) | (u8[at + 1] << 16) | (u8[at + 2] << 8) | u8[at + 3]) >>>
    0
  );
}

function sshString(
  u8: Uint8Array,
  at: number,
): { data: Uint8Array; next: number } | null {
  if (at + 4 > u8.length) return null;
  const len = readU32be(u8, at);
  if (at + 4 + len > u8.length) return null;
  return { data: u8.subarray(at + 4, at + 4 + len), next: at + 4 + len };
}

function base64Decode(text: string): Uint8Array {
  const bin = atob(text);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function utf8(u8: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    return null;
  }
}

/* --- container classification ---------------------------------------------- */

function looksLikeHeaderLine(line: string): boolean {
  return /^[A-Za-z0-9-]+:/.test(line);
}

/** "BEGIN RSA|DSA|EC|PRIVATE KEY" body → DER structure class. */
function classifyDer(u8: Uint8Array): PrivateKeyKind {
  const seq = derExpect(u8, 0, 0x30);
  if (seq === null) return 'unknown';
  const version = derExpect(u8, seq.bodyStart, 0x02);
  if (version === null || version.bodyEnd - version.bodyStart !== 1) {
    return 'unknown';
  }
  const v = u8[version.bodyStart];
  if (v === 0x01) {
    // SEC1 EC: version 1, then OCTET STRING privateKey ([0] curve and [1]
    // pubkey are optional). Version 1 plus an octet string is only the EC
    // shape among the formats handled here — classify it as ECDSA even when
    // the optional curve OID is missing, so an unclassifiable EC key still
    // refuses rather than slips through.
    return derExpect(u8, version.next, 0x04) !== null ? 'ecdsa' : 'unknown';
  }
  if (v !== 0x00) return 'unknown';

  // Version 0: PKCS#1 (RSA/DSA: all children INTEGERs) or PKCS#8 (version,
  // AlgorithmIdentifier SEQUENCE, OCTET STRING).
  const algSeq = derExpect(u8, version.next, 0x30);
  if (algSeq !== null) {
    const oid = derExpect(u8, algSeq.bodyStart, 0x06);
    if (oid === null) return 'unknown';
    const oidText = readOid(u8, oid.bodyStart, oid.bodyEnd);
    switch (oidText) {
      case '1.2.840.10045.2.1': // id-ecPublicKey (SEC1 inside PKCS#8)
        return 'ecdsa';
      case '1.2.840.113549.1.1.1': // rsaEncryption
        return 'rsa';
      case '1.3.101.112': // id-Ed25519
        return 'ed25519';
      case '1.2.840.10040.4.1': // id-dsa
        return 'dsa';
      default:
        // PBES1/PBES2 family — EncryptedPrivateKeyInfo, not a usable key here
        if (oidText !== null && oidText.startsWith('1.2.840.113549.1.5.')) {
          return 'encrypted';
        }
        return 'unknown';
    }
  }

  let ints = 0;
  let cursor = seq.bodyStart;
  while (true) {
    const field = derExpect(u8, cursor, 0x02);
    if (field === null) break;
    ints += 1;
    cursor = field.next;
  }
  // PKCS#1 RSA: version,n,e,d,p,q,dp,dq,qinv = 9 INTEGERs
  // PKCS#1 DSA: version,p,q,g,y,x = 6 INTEGERs
  if (ints === 9) return 'rsa';
  if (ints === 6) return 'dsa';
  return 'unknown';
}

/** openssh-key-v1 container: cipher/kdf names say "encrypted"; the first
 * public key blob's type string says which algorithm is inside. */
function classifyOpenSSHContainer(inner: string): PrivateKeyKind {
  const lines = inner
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !looksLikeHeaderLine(line));
  if (lines.length === 0) return 'unknown';
  let u8: Uint8Array;
  try {
    u8 = base64Decode(lines.join(''));
  } catch {
    return 'unknown';
  }
  const magic = 'openssh-key-v1';
  if (u8.length < magic.length + 1) return 'unknown';
  for (let i = 0; i < magic.length; i++) {
    if (u8[i] !== magic.charCodeAt(i)) return 'unknown';
  }
  if (u8[magic.length] !== 0x00) return 'unknown';
  let at = magic.length + 1;
  const cipher = sshString(u8, at);
  if (cipher === null) return 'unknown';
  at = cipher.next;
  if (utf8(cipher.data) !== 'none') return 'encrypted';
  const kdf = sshString(u8, at);
  if (kdf === null) return 'unknown';
  at = kdf.next;
  if (utf8(kdf.data) !== 'none') return 'encrypted';
  const kdfOpts = sshString(u8, at);
  if (kdfOpts === null) return 'unknown';
  at = kdfOpts.next;
  if (at + 4 > u8.length) return 'unknown';
  const keyCount = readU32be(u8, at);
  if (keyCount < 1) return 'unknown';
  const pubBlob = sshString(u8, at + 4);
  if (pubBlob === null) return 'unknown';
  const typeField = sshString(pubBlob.data, 0);
  if (typeField === null) return 'unknown';
  switch (utf8(typeField.data)) {
    case 'ssh-rsa':
      return 'rsa';
    case 'ssh-dss':
      return 'dsa';
    case 'ssh-ed25519':
      return 'ed25519';
    case 'ecdsa-sha2-nistp256':
    case 'ecdsa-sha2-nistp384':
    case 'ecdsa-sha2-nistp521':
      return 'ecdsa';
    default:
      return 'unknown';
  }
}

/** Classify a private key from its PEM text (or the UTF-8 bytes of one).
 * Raw DER without a PEM header is not a form this module receives from
 * ssh2's parser, so it classifies as unknown. */
export function classifyPrivateKey(raw: string | Uint8Array): PrivateKeyKind {
  const text = typeof raw === 'string' ? raw : (utf8(raw) ?? null);
  if (text === null) return 'unknown';
  const begin = /-----BEGIN ([A-Z0-9 ]+)-----/.exec(text);
  if (begin === null) return 'unknown';
  const label = begin[1];
  const endMarker = `-----END ${label}-----`;
  const endAt = text.indexOf(endMarker, begin.index + begin[0].length);
  if (endAt === -1) return 'unknown';
  const inner = text.slice(begin.index + begin[0].length, endAt);

  if (label === 'OPENSSH PRIVATE KEY') return classifyOpenSSHContainer(inner);
  if (label === 'ENCRYPTED PRIVATE KEY') return 'encrypted';
  if (
    label !== 'RSA PRIVATE KEY' &&
    label !== 'DSA PRIVATE KEY' &&
    label !== 'EC PRIVATE KEY' &&
    label !== 'PRIVATE KEY'
  ) {
    return 'unknown';
  }

  let sawBase64 = false;
  const b64: string[] = [];
  for (const rawLine of inner.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (looksLikeHeaderLine(line)) {
      // RFC 1423 fragmentation headers — a present Proc-Type/DEK-Info means
      // the DER below is ciphertext, not a classifiable key.
      if (/^(Proc-Type|DEK-Info):/i.test(line)) return 'encrypted';
      continue;
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(line)) return 'unknown';
    sawBase64 = true;
    b64.push(line);
  }
  if (!sawBase64) return 'unknown';
  let u8: Uint8Array;
  try {
    u8 = base64Decode(b64.join(''));
  } catch {
    return 'unknown';
  }
  return classifyDer(u8);
}

/* --- user-facing assessment ------------------------------------------------ */

export const ECDSA_REFUSAL_REASON =
  'ECDSA signing is not allowed in the browser build — use an Ed25519 or RSA key instead.';
const ENCRYPTED_REASON =
  'The key is passphrase-encrypted in this form; whether it is usable is decided after ssh2 decrypts it.';
const UNKNOWN_REASON =
  'The key format was not recognized, so the browser build refuses to sign with it.';

/** Early, user-facing verdict for a stored private key. This is advisory
 * only — the authoritative fail-closed check runs again at the signing
 * boundary (shim `sign` and `createSign().sign`) on whatever PEM the key
 * parser actually produced. */
export function assessPrivateKeyAuth(raw: string | Uint8Array): PrivateKeyAssessment {
  const kind = classifyPrivateKey(raw);
  switch (kind) {
    case 'rsa':
    case 'dsa':
    case 'ed25519':
      return {
        kind,
        verdict: 'allowed',
        reason: `${kind} keys can sign from the browser build.`,
      };
    case 'ecdsa':
      return { kind, verdict: 'refused', reason: ECDSA_REFUSAL_REASON };
    case 'encrypted':
      return { kind, verdict: 'indeterminate', reason: ENCRYPTED_REASON };
    default:
      return { kind: 'unknown', verdict: 'indeterminate', reason: UNKNOWN_REASON };
  }
}
