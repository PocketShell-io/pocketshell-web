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
 * user-facing check can judge the key as the user stored it, before ssh2
 * has converted anything: unencrypted (cipher=none) containers are parsed
 * down to their validated private section, while encrypted containers can
 * only be judged by their headers — the ciphertext cannot be checked — so
 * their verdict is advisory and the signing boundary re-classifies the
 * decrypted PEM ssh2 actually produces.
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
 * tag byte. Long-form lengths are accepted up to 4 bytes and must be
 * minimally encoded (DER); indefinite (0x80), padded and oversized forms
 * return null — a truncated or exotic encoding must classify as unknown,
 * not crash. */
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
    // DER: long form only for lengths > 127, and no leading zero byte.
    if (len <= 0x7f || u8[pos] === 0) return null;
    pos += n;
  }
  if (pos + len > u8.length) return null;
  return { bodyStart: pos, bodyEnd: pos + len, next: pos + len };
}

/** [from, end) must be empty or exactly one complete TLV (any tag) — the
 * optional `parameters` component of an AlgorithmIdentifier. */
function singleTrailingTlv(u8: Uint8Array, from: number, end: number): boolean {
  if (from === end) return true;
  if (from + 2 > end) return false;
  const tlv = derExpect(u8, from, u8[from] ?? -1);
  return tlv !== null && tlv.next === end;
}

/** Consecutive INTEGER TLVs from `start` filling [start, end) exactly; null
 * when a non-INTEGER, a malformed TLV or trailing bytes interrupt the run. */
function integerRun(u8: Uint8Array, start: number, end: number): number | null {
  let count = 0;
  let cursor = start;
  while (cursor < end) {
    const field = derExpect(u8, cursor, 0x02);
    if (field === null) return null;
    count += 1;
    cursor = field.next;
  }
  return count;
}

/** PKCS#1 shape at [start, end): SEQUENCE, exactly filling the span, of
 * version 0 + INTEGERs — 9 total (RSA) or 6 total (DSA). */
function pkcs1Shape(
  u8: Uint8Array,
  start: number,
  end: number,
): 'rsa' | 'dsa' | 'unknown' {
  const seq = derExpect(u8, start, 0x30);
  if (seq === null || seq.bodyEnd !== end) return 'unknown';
  const version = derExpect(u8, seq.bodyStart, 0x02);
  if (
    version === null ||
    version.bodyEnd - version.bodyStart !== 1 ||
    u8[version.bodyStart] !== 0x00
  ) {
    return 'unknown';
  }
  const ints = integerRun(u8, seq.bodyStart, seq.bodyEnd);
  if (ints === 9) return 'rsa';
  if (ints === 6) return 'dsa';
  return 'unknown';
}

/** SEC1 ECPrivateKey shape at [start, end): version 1, OCTET STRING, then
 * only optional [0] curve / [1] pubkey TLVs, all exactly filling the span. */
function sec1Shape(u8: Uint8Array, start: number, end: number): boolean {
  const version = derExpect(u8, start, 0x02);
  if (
    version === null ||
    version.bodyEnd - version.bodyStart !== 1 ||
    u8[version.bodyStart] !== 0x01
  ) {
    return false;
  }
  const octet = derExpect(u8, version.next, 0x04);
  if (octet === null) return false;
  let cursor = octet.next;
  while (cursor < end) {
    const tag = u8[cursor];
    // RFC 5915 explicit [0]/[1] (0xA0/0xA1); legacy primitive [1] (0x81).
    if (tag !== 0xa0 && tag !== 0xa1 && tag !== 0x81) return false;
    const tlv = derExpect(u8, cursor, tag);
    if (tlv === null) return false;
    cursor = tlv.next;
  }
  return cursor === end;
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

/** "BEGIN RSA|DSA|EC|PRIVATE KEY" body → DER structure class. The outer
 * SEQUENCE must exactly consume the whole DER buffer — a parent that ends
 * early (truncation) or leaves trailing bytes after it is not a key this
 * module classifies. */
function classifyDer(u8: Uint8Array): PrivateKeyKind {
  const seq = derExpect(u8, 0, 0x30);
  if (seq === null || seq.bodyEnd !== u8.length) return 'unknown';
  const version = derExpect(u8, seq.bodyStart, 0x02);
  if (version === null || version.bodyEnd - version.bodyStart !== 1) {
    return 'unknown';
  }
  const v = u8[version.bodyStart];
  if (v === 0x01) {
    // SEC1 EC: version 1, then OCTET STRING privateKey, then only optional
    // [0] curve / [1] pubkey. Version 1 alone is not enough — the full
    // shape must hold, so an unclassifiable EC form still refuses rather
    // than slips through.
    return sec1Shape(u8, seq.bodyStart, seq.bodyEnd) ? 'ecdsa' : 'unknown';
  }
  if (v !== 0x00) return 'unknown';

  // Version 0: PKCS#8 (version, AlgorithmIdentifier SEQUENCE, OCTET STRING)
  // or PKCS#1 (RSA/DSA: nothing but INTEGERs).
  const algSeq = derExpect(u8, version.next, 0x30);
  if (algSeq !== null) {
    const oid = derExpect(u8, algSeq.bodyStart, 0x06);
    if (oid === null) return 'unknown';
    // AlgorithmIdentifier = SEQUENCE { algorithm OID, parameters ANY } —
    // after the OID only one complete parameters TLV may remain.
    if (!singleTrailingTlv(u8, oid.next, algSeq.bodyEnd)) return 'unknown';
    const octet = derExpect(u8, algSeq.next, 0x04);
    if (octet === null || octet.bodyEnd !== seq.bodyEnd) return 'unknown';
    return classifyPkcs8Inner(u8, oid, octet);
  }

  // PKCS#1 RSA: version,n,e,d,p,q,dp,dq,qinv = 9 INTEGERs; PKCS#1 DSA:
  // version,p,q,g,y,x = 6 INTEGERs — exactly filling the SEQUENCE.
  const ints = integerRun(u8, seq.bodyStart, seq.bodyEnd);
  if (ints === 9) return 'rsa';
  if (ints === 6) return 'dsa';
  return 'unknown';
}

/** PKCS#8 privateKeyOctet validation: the inner payload must structurally
 * match the declared algorithm OID — an OCTET STRING claiming rsaEncryption
 * whose content is not a PKCS#1 RSA shape classifies as unknown, not rsa. */
function classifyPkcs8Inner(
  u8: Uint8Array,
  oid: DerSpan,
  octet: DerSpan,
): PrivateKeyKind {
  const oidText = readOid(u8, oid.bodyStart, oid.bodyEnd);
  const innerStart = octet.bodyStart;
  const innerEnd = octet.bodyEnd;
  switch (oidText) {
    case '1.2.840.113549.1.1.1': // rsaEncryption — inner is PKCS#1 RSA
      return pkcs1Shape(u8, innerStart, innerEnd);
    case '1.2.840.10040.4.1': {
      // id-dsa — PKCS#8 carries only the private exponent here (an INTEGER;
      // the domain parameters ride in the AlgorithmIdentifier). The PKCS#1
      // -style DSA SEQUENCE is only the legacy "BEGIN DSA PRIVATE KEY"
      // top-level form, handled above.
      const x = derExpect(u8, innerStart, 0x02);
      return x !== null && x.bodyEnd === innerEnd ? 'dsa' : 'unknown';
    }
    case '1.2.840.10045.2.1': {
      // id-ecPublicKey — inner is a full SEC1 ECPrivateKey DER
      const seq = derExpect(u8, innerStart, 0x30);
      if (seq === null || seq.bodyEnd !== innerEnd) return 'unknown';
      return sec1Shape(u8, seq.bodyStart, seq.bodyEnd) ? 'ecdsa' : 'unknown';
    }
    case '1.3.101.112': {
      // id-Ed25519 — inner is exactly OCTET STRING(32) (RFC 8410)
      const seed = derExpect(u8, innerStart, 0x04);
      return seed !== null &&
        seed.bodyEnd === innerEnd &&
        seed.bodyEnd - seed.bodyStart === 32
        ? 'ed25519'
        : 'unknown';
    }
    default:
      // PBES1/PBES2 family — EncryptedPrivateKeyInfo, not a usable key here
      if (oidText !== null && oidText.startsWith('1.2.840.113549.1.5.')) {
        return 'encrypted';
      }
      return 'unknown';
  }
}

/** Wire type string → classification kind. */
function kindOfTypeString(type: string | null): PrivateKeyKind {
  switch (type) {
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

/** Private-section field counts after the type string (PROTOCOL.key); the
 * framing is uniform u32-length fields for every type. A trailing comment
 * string follows the key fields for every type, then 1..255 padding bytes
 * of canonical 1..N. */
const OPENSSH_PRIVATE_FIELDS: Record<string, number> = {
  'ssh-rsa': 6, // n, e, d, iqmp, p, q
  'ssh-dss': 5, // p, q, g, y, x
  'ssh-ed25519': 2, // A (public), secret (64-byte form on current OpenSSH)
  'ecdsa-sha2-nistp256': 3, // curve name, Q, scalar
  'ecdsa-sha2-nistp384': 3,
  'ecdsa-sha2-nistp521': 3,
};

/** Validate the DECRYPTED private section of a cipher=none container: the
 * section must consume the container exactly, its check ints must agree, its
 * own type string must match the public header, its per-type fields plus the
 * comment must frame exactly, and the padding (present only when the section
 * is not already 8-byte aligned) must be canonical increasing 1..N. This is
 * what makes the unencrypted-container verdict read the ACTUAL private key
 * rather than trusting the public header. */
function classifyOpenSSHPrivateSection(
  u8: Uint8Array,
  at: number,
  pubType: string,
): PrivateKeyKind {
  const priv = sshString(u8, at);
  if (priv === null || priv.next !== u8.length) return 'unknown';
  const p = priv.data;
  if (p.length < 12) return 'unknown';
  const check1 = readU32be(p, 0);
  const check2 = readU32be(p, 4);
  if (check1 !== check2) return 'unknown';
  const typeField = sshString(p, 8);
  if (typeField === null) return 'unknown';
  const privType = utf8(typeField.data);
  // Header and body must agree; a mismatch is a malformed container, not a
  // key either name promises.
  if (privType !== pubType) return 'unknown';
  const fields = OPENSSH_PRIVATE_FIELDS[pubType];
  if (fields === undefined) return 'unknown';
  let cursor = typeField.next;
  for (let i = 0; i < fields + 1; i++) {
    // key fields, then the comment string (possibly empty)
    const field = sshString(p, cursor);
    if (field === null) return 'unknown';
    cursor = field.next;
  }
  // Padding: OpenSSH pads only up to the next 8-byte boundary, so an
  // already-aligned section carries NO padding — 0..255 bytes, and when
  // present the canonical increasing 1..N.
  const padLen = p.length - cursor;
  if (padLen < 0 || padLen > 255) return 'unknown';
  for (let i = 0; i < padLen; i++) {
    if (p[cursor + i] !== i + 1) return 'unknown';
  }
  return kindOfTypeString(privType);
}

/** openssh-key-v1 container. For encrypted containers the cipher/KDF names
 * classify as "encrypted" — the ciphertext body cannot be checked without
 * the passphrase, so the header is ADVISORY there and the signing boundary
 * re-classifies whatever ssh2 produces after decryption. For cipher=none
 * containers the actual private section is parsed and validated. */
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
  // ssh2 consumes single-key containers; anything else is not a form this
  // module classifies.
  if (keyCount !== 1) return 'unknown';
  const pubBlob = sshString(u8, at + 4);
  if (pubBlob === null) return 'unknown';
  const typeField = sshString(pubBlob.data, 0);
  if (typeField === null) return 'unknown';
  const pubType = utf8(typeField.data);
  if (pubType === null || kindOfTypeString(pubType) === 'unknown') return 'unknown';
  return classifyOpenSSHPrivateSection(u8, pubBlob.next, pubType);
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
