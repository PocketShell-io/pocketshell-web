/**
 * Structural classification of SSH private-key PEM forms — without executing
 * any key-dependent crypto. The browser signing guard must decide what a key
 * IS before browserify-sign (and behind it elliptic) ever receives it; once
 * the vulnerable ECDSA signer runs, it is too late to contain.
 *
 * The input contract is deliberately narrow: the text must be exactly ONE
 * complete recognized PEM envelope — BEGIN/END markers with the same label,
 * whitespace-only outside, label and contained DER structure in agreement.
 * Anything else (junk around the block, extra blocks, mismatched markers,
 * a label promising one algorithm over another's DER) classifies as
 * "unknown", because ambiguity must fail closed at both the early
 * assessment and the authoritative signing boundary.
 *
 * The PEMs that reach the signing boundary come from ssh2's key parser
 * (ssh2/lib/protocol/keyParser.js), which re-serializes every container it
 * accepts — OpenSSH, legacy "BEGIN x PRIVATE KEY" (optionally decrypted),
 * PPK — into OpenSSL PEMs: PKCS#1 RSA/DSA, SEC1 EC, PKCS#8 Ed25519. The
 * classifier also reads the raw OpenSSH container itself so an early
 * user-facing check can judge the key as the user stored it, before ssh2
 * has converted anything: unencrypted (cipher=none) containers are parsed
 * down to their validated private section — real per-type field structure,
 * public/private agreement, OpenSSH's pad-to-8 alignment — while encrypted
 * containers can only be judged by their headers — the ciphertext cannot be
 * checked — so their verdict is advisory and the signing boundary
 * re-classifies the decrypted PEM ssh2 actually produces.
 *
 * What this module does NOT claim: cryptographic validity of the secret
 * math (primality, p·q = n, scalar·G = Q) is never verified; a passing
 * verdict means "structurally the declared key type", nothing more.
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

/** DER INTEGER body of a key field: a meaningful, minimal encoding of a
 * POSITIVE value — never empty, never zero (version fields are validated
 * separately), at most one leading 0x00 octet and only as sign padding in
 * front of a value whose next octet's high bit demands it. A body whose
 * first octet has the high bit set without the pad encodes a negative
 * number — not a legal key field. */
function strictPositiveInteger(u8: Uint8Array, start: number, end: number): boolean {
  const len = end - start;
  if (len < 1) return false;
  if (u8[start] === 0x00) {
    return len > 1 && (u8[start + 1] & 0x80) !== 0;
  }
  return (u8[start] & 0x80) === 0;
}

/** Consecutive strict positive INTEGER TLVs from `start` filling
 * [start, end) exactly; null when a non-INTEGER, a malformed TLV, an empty
 * / zero / nonminimal / negative body or trailing bytes interrupt the run. */
function integerRun(u8: Uint8Array, start: number, end: number): number | null {
  let count = 0;
  let cursor = start;
  while (cursor < end) {
    const field = derExpect(u8, cursor, 0x02);
    if (field === null) return null;
    if (!strictPositiveInteger(u8, field.bodyStart, field.bodyEnd)) return null;
    count += 1;
    cursor = field.next;
  }
  return count;
}

/** PKCS#1 shape at [start, end): SEQUENCE, exactly filling the span, of
 * version 0 + `intFields` strict positive INTEGERs — RSA: n,e,d,p,q,dp,dq,
 * qinv (8 after the version); DSA: p,q,g,y,x (5). The INTEGER count alone
 * decides nothing: every field must carry meaningful DER integer content. */
function pkcs1Shape(u8: Uint8Array, start: number, end: number, intFields: number): boolean {
  const seq = derExpect(u8, start, 0x30);
  if (seq === null || seq.bodyEnd !== end) return false;
  const version = derExpect(u8, seq.bodyStart, 0x02);
  if (
    version === null ||
    version.bodyEnd - version.bodyStart !== 1 ||
    u8[version.bodyStart] !== 0x00
  ) {
    return false;
  }
  return integerRun(u8, version.next, seq.bodyEnd) === intFields;
}

/** SEC1 ECPrivateKey shape at [start, end): version 1, a non-empty OCTET
 * STRING privateKey, then only optional [0] curve / [1] pubkey TLVs, all
 * exactly filling the span. A constructed [1] must hold exactly one BIT
 * STRING with more than just the unused-bits octet; the legacy primitive
 * [1] form must be non-empty. */
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
  if (octet === null || octet.bodyEnd === octet.bodyStart) return false;
  let cursor = octet.next;
  while (cursor < end) {
    const tag = u8[cursor];
    // RFC 5915 explicit [0]/[1] (0xA0/0xA1); legacy primitive [1] (0x81).
    if (tag !== 0xa0 && tag !== 0xa1 && tag !== 0x81) return false;
    const tlv = derExpect(u8, cursor, tag);
    if (tlv === null) return false;
    if (tag === 0xa1) {
      const bit = derExpect(u8, tlv.bodyStart, 0x03);
      if (bit === null || bit.bodyEnd !== tlv.bodyEnd) return false;
      if (bit.bodyEnd - bit.bodyStart < 2) return false; // unused-bits + ≥1 point byte
    } else if (tag === 0x81 && tlv.bodyEnd === tlv.bodyStart) {
      return false;
    }
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

/** Label-driven DER classification: the PEM label and the DER structure
 * must AGREE. A "BEGIN RSA PRIVATE KEY" whose DER is a SEC1 EC key, a
 * "PRIVATE KEY" whose DER is a bare PKCS#1 INTEGER run, a "DSA PRIVATE
 * KEY" holding nine INTEGERs — every such mismatch classifies as unknown,
 * never as whichever shape the DER happens to walk into. */
function classifyDer(u8: Uint8Array, label: string): PrivateKeyKind {
  switch (label) {
    case 'RSA PRIVATE KEY':
      return pkcs1Shape(u8, 0, u8.length, 8) ? 'rsa' : 'unknown';
    case 'DSA PRIVATE KEY':
      return pkcs1Shape(u8, 0, u8.length, 5) ? 'dsa' : 'unknown';
    case 'EC PRIVATE KEY': {
      // SEC1: an outer SEQUENCE wraps { version 1, privateKey, … } — the
      // shape walk starts inside it. The SEQUENCE must exactly consume the
      // whole DER buffer (truncation or trailing bytes refuse).
      const seq = derExpect(u8, 0, 0x30);
      if (seq === null || seq.bodyEnd !== u8.length) return 'unknown';
      return sec1Shape(u8, seq.bodyStart, seq.bodyEnd) ? 'ecdsa' : 'unknown';
    }
    case 'PRIVATE KEY':
      return classifyPkcs8(u8);
    default:
      return 'unknown';
  }
}

/** PKCS#8 PrivateKeyInfo at [0, len): SEQUENCE exactly filling the buffer,
 * of version 0 + AlgorithmIdentifier SEQUENCE + OCTET STRING. */
function classifyPkcs8(u8: Uint8Array): PrivateKeyKind {
  const seq = derExpect(u8, 0, 0x30);
  if (seq === null || seq.bodyEnd !== u8.length) return 'unknown';
  const version = derExpect(u8, seq.bodyStart, 0x02);
  if (
    version === null ||
    version.bodyEnd - version.bodyStart !== 1 ||
    u8[version.bodyStart] !== 0x00
  ) {
    return 'unknown';
  }
  const algSeq = derExpect(u8, version.next, 0x30);
  if (algSeq === null) return 'unknown';
  const oid = derExpect(u8, algSeq.bodyStart, 0x06);
  if (oid === null) return 'unknown';
  // AlgorithmIdentifier = SEQUENCE { algorithm OID, parameters ANY } —
  // after the OID only one complete parameters TLV may remain.
  if (!singleTrailingTlv(u8, oid.next, algSeq.bodyEnd)) return 'unknown';
  const octet = derExpect(u8, algSeq.next, 0x04);
  if (octet === null || octet.bodyEnd !== seq.bodyEnd) return 'unknown';
  return classifyPkcs8Inner(u8, oid, octet);
}

/** PKCS#8 privateKeyOctet validation: the inner payload must structurally
 * match the declared algorithm OID — EXACTLY. A payload claiming
 * rsaEncryption must be the full PKCS#1 RSA shape: the six-INTEGER DSA
 * body under an rsaEncryption OID is a mismatch, not a DSA key. Every
 * mismatch classifies as unknown. */
function classifyPkcs8Inner(
  u8: Uint8Array,
  oid: DerSpan,
  octet: DerSpan,
): PrivateKeyKind {
  const oidText = readOid(u8, oid.bodyStart, oid.bodyEnd);
  const innerStart = octet.bodyStart;
  const innerEnd = octet.bodyEnd;
  switch (oidText) {
    case '1.2.840.113549.1.1.1': // rsaEncryption — inner is EXACTLY PKCS#1
      // RSA (version + the 8 RSA fields); no other INTEGER run, in
      // particular no DSA-shaped 5-field payload, may pass under this OID.
      return pkcs1Shape(u8, innerStart, innerEnd, 8) ? 'rsa' : 'unknown';
    case '1.2.840.10040.4.1': {
      // id-dsa — PKCS#8 carries only the private exponent here (a strict
      // positive INTEGER; the domain parameters ride in the
      // AlgorithmIdentifier). The PKCS#1-style DSA SEQUENCE is only the
      // legacy "BEGIN DSA PRIVATE KEY" top-level form, handled above.
      const x = derExpect(u8, innerStart, 0x02);
      return x !== null &&
        x.bodyEnd === innerEnd &&
        strictPositiveInteger(u8, x.bodyStart, x.bodyEnd)
        ? 'dsa'
        : 'unknown';
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
 * framing is uniform u32-length fields for every type, then a trailing
 * comment string, then OpenSSH's pad-to-8 (0..7 bytes, canonical 1..N when
 * present). */
const OPENSSH_PRIVATE_FIELDS: Record<string, number> = {
  'ssh-rsa': 6, // n, e, d, iqmp, p, q
  'ssh-dss': 5, // p, q, g, y, x
  'ssh-ed25519': 2, // A (public), secret (64-byte form on current OpenSSH)
  'ecdsa-sha2-nistp256': 3, // curve name, Q, scalar
  'ecdsa-sha2-nistp384': 3,
  'ecdsa-sha2-nistp521': 3,
};

/** Public-blob field counts after the type string (RFC 4253). */
const OPENSSH_PUBLIC_FIELDS: Record<string, number> = {
  'ssh-rsa': 2, // e, n
  'ssh-dss': 4, // p, q, g, y
  'ssh-ed25519': 1, // A
  'ecdsa-sha2-nistp256': 2, // curve name, Q
  'ecdsa-sha2-nistp384': 2,
  'ecdsa-sha2-nistp521': 2,
};

/** Byte length of one NIST curve coordinate (uncompressed point form). */
const ECDSA_COORD_BYTES: Record<string, number> = {
  nistp256: 32,
  nistp384: 48,
  nistp521: 66,
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** a < b for two already-validated positive minimal SSH mpints (strip the
 * single sign-pad octet, then length + lexicographic compare). */
function mpintLess(a: Uint8Array, b: Uint8Array): boolean {
  const sa = a[0] === 0x00 ? a.subarray(1) : a;
  const sb = b[0] === 0x00 ? b.subarray(1) : b;
  if (sa.length !== sb.length) return sa.length < sb.length;
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return (sa[i] ?? 0) < (sb[i] ?? 0);
  }
  return false; // equal
}

function allValidMpints(fields: Uint8Array[]): boolean {
  return fields.every((f) => strictPositiveInteger(f, 0, f.length));
}

/** Per-type structural agreement between the public blob and the decrypted
 * private section of a cipher=none container — the ACTUAL fields, not just
 * their count: every field must carry a meaningful mpint/point/octet, the
 * public and private halves must agree (same n/e, same p/q/g/y, same A,
 * same curve and Q), and the necessary order relations of a real key must
 * hold (e,d,p,q < n; iqmp < p; x,y,g < p and x < q for DSA; scalar ≤
 * coordinate size for EC). This is structure, NOT secret math: no primality
 * of p/q, no p·q = n, no scalar·G = Q is checked here — those remain the
 * consumer's job. */
function validateOpenSshKeyFields(
  pubType: string,
  pub: Uint8Array[],
  priv: Uint8Array[],
): boolean {
  switch (pubType) {
    case 'ssh-rsa': {
      // pub [e, n]; priv [n, e, d, iqmp, p, q]
      if (pub.length !== 2 || priv.length !== 6) return false;
      const [e, n] = pub as [Uint8Array, Uint8Array];
      const [n2, e2, d, iqmp, p, q] = priv as Uint8Array[];
      if (!allValidMpints([e, n, ...priv])) return false;
      return (
        bytesEqual(n2, n) &&
        bytesEqual(e2, e) &&
        mpintLess(e, n) &&
        mpintLess(d, n) &&
        mpintLess(p, n) &&
        mpintLess(q, n) &&
        mpintLess(iqmp, p)
      );
    }
    case 'ssh-dss': {
      // pub [p, q, g, y]; priv [p, q, g, y, x]
      if (pub.length !== 4 || priv.length !== 5) return false;
      const [p, q, g, y] = pub as Uint8Array[];
      if (!allValidMpints([...pub, ...priv])) return false;
      const [p2, q2, g2, y2, x] = priv as Uint8Array[];
      return (
        bytesEqual(p2, p) &&
        bytesEqual(q2, q) &&
        bytesEqual(g2, g) &&
        bytesEqual(y2, y) &&
        mpintLess(g, p) &&
        mpintLess(y, p) &&
        mpintLess(x, q)
      );
    }
    case 'ssh-ed25519': {
      // pub [A]; priv [A, secret] — canonical OpenSSH sizes, and the
      // private A must be THE public A, not just some 32 bytes.
      if (pub.length !== 1 || priv.length !== 2) return false;
      const [pubA] = pub as [Uint8Array];
      const [privA, secret] = priv as Uint8Array[];
      return (
        pubA.length === 32 &&
        privA.length === 32 &&
        secret.length === 64 &&
        bytesEqual(privA, pubA)
      );
    }
    default: {
      if (!pubType.startsWith('ecdsa-sha2-')) return false;
      const curve = pubType.slice('ecdsa-sha2-'.length);
      const coord = ECDSA_COORD_BYTES[curve];
      if (coord === undefined) return false;
      // pub [curveName, Q]; priv [curveName, Q, scalar]
      if (pub.length !== 2 || priv.length !== 3) return false;
      const [pubCurve, pubQ] = pub as Uint8Array[];
      const [privCurve, privQ, scalar] = priv as Uint8Array[];
      const uncompressedPoint = (q: Uint8Array) =>
        q.length === 1 + 2 * coord && q[0] === 0x04;
      // scalar ≤ order: the value must fit the coordinate size — the sign
      // pad (one 0x00 octet) is part of the encoding, not the value
      const scalarValueBytes = scalar[0] === 0x00 ? scalar.length - 1 : scalar.length;
      return (
        utf8(pubCurve) === curve &&
        bytesEqual(privCurve, pubCurve) &&
        uncompressedPoint(pubQ) &&
        uncompressedPoint(privQ) &&
        bytesEqual(privQ, pubQ) &&
        strictPositiveInteger(scalar, 0, scalar.length) &&
        scalarValueBytes <= coord
      );
    }
  }
}

/** Consecutive SSH strings from `at` consuming exactly [at, end). */
function sshFieldRun(u8: Uint8Array, at: number, end: number): Uint8Array[] | null {
  const fields: Uint8Array[] = [];
  let cursor = at;
  while (cursor < end) {
    const field = sshString(u8, cursor);
    if (field === null || field.next > end) return null;
    fields.push(field.data);
    cursor = field.next;
  }
  return fields;
}

/** Validate the DECRYPTED private section of a cipher=none container: the
 * section must consume the container exactly AND be 8-byte aligned (OpenSSH
 * pads with its while-loop to the next multiple of 8, so aligned sections
 * legitimately carry no padding), its check ints must agree, its own type
 * string must match the public header, the field counts must frame exactly
 * with the trailing comment, the padding (0..7 bytes) must be the canonical
 * increasing 1..N, and the per-type fields must structurally validate and
 * agree with the public blob (see validateOpenSshKeyFields). This is what
 * makes the unencrypted-container verdict read the ACTUAL private key
 * rather than trusting the public header. */
function classifyOpenSSHPrivateSection(
  u8: Uint8Array,
  at: number,
  pubType: string,
  pubFields: Uint8Array[],
): PrivateKeyKind {
  const priv = sshString(u8, at);
  if (priv === null || priv.next !== u8.length) return 'unknown';
  const p = priv.data;
  if (p.length < 12 || p.length % 8 !== 0) return 'unknown';
  const check1 = readU32be(p, 0);
  const check2 = readU32be(p, 4);
  if (check1 !== check2) return 'unknown';
  const typeField = sshString(p, 8);
  if (typeField === null) return 'unknown';
  const privType = utf8(typeField.data);
  // Header and body must agree; a mismatch is a malformed container, not a
  // key either name promises.
  if (privType !== pubType) return 'unknown';
  const fieldCount = OPENSSH_PRIVATE_FIELDS[pubType];
  if (fieldCount === undefined) return 'unknown';
  const fields: Uint8Array[] = [];
  let cursor = typeField.next;
  for (let i = 0; i < fieldCount + 1; i++) {
    // key fields, then the comment string (possibly empty)
    const field = sshString(p, cursor);
    if (field === null) return 'unknown';
    fields.push(field.data);
    cursor = field.next;
  }
  // Padding: 0..7 bytes (the section is already 8-byte aligned), and when
  // present the canonical increasing 1..N.
  const padLen = p.length - cursor;
  if (padLen > 7) return 'unknown';
  for (let i = 0; i < padLen; i++) {
    if (p[cursor + i] !== i + 1) return 'unknown';
  }
  if (!validateOpenSshKeyFields(pubType, pubFields, fields.slice(0, fieldCount))) {
    return 'unknown';
  }
  return kindOfTypeString(pubType);
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
  // The public blob must be exactly: type string + the type's public
  // fields — no fewer, no extra.
  const pubFields = sshFieldRun(pubBlob.data, 0, pubBlob.data.length);
  if (pubFields === null || pubFields.length === 0) return 'unknown';
  const pubType = utf8(pubFields[0]);
  if (pubType === null || kindOfTypeString(pubType) === 'unknown') return 'unknown';
  if (pubFields.length - 1 !== OPENSSH_PUBLIC_FIELDS[pubType]) return 'unknown';
  return classifyOpenSSHPrivateSection(u8, pubBlob.next, pubType, pubFields.slice(1));
}

/** The single-envelope input contract: exactly ONE complete PEM envelope —
 * BEGIN and END markers carrying the SAME label — with nothing but
 * whitespace outside it. Leading junk, trailing junk, additional PEM
 * blocks, split markers and BEGIN/END label mismatches all fail here, so
 * an ambiguous input classifies as unknown instead of as whichever block
 * a "find BEGIN anywhere, then the first END" scan happened to pick. The
 * non-greedy body binds to the FIRST matching END marker; the end anchors
 * make any further marker part of the match failure. */
const PEM_ENVELOPE_RE =
  /^[ \t\r\n]*-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----[ \t\r\n]*$/;

function extractPemEnvelope(text: string): { label: string; inner: string } | null {
  const match = PEM_ENVELOPE_RE.exec(text);
  if (match === null) return null;
  return { label: match[1] ?? '', inner: match[2] ?? '' };
}

/** Classify a private key from its PEM text (or the UTF-8 bytes of one).
 * Raw DER without a PEM envelope is not a form this module receives from
 * ssh2's parser, so it classifies as unknown — as does any input that is
 * not exactly one recognized, complete, internally consistent envelope. */
export function classifyPrivateKey(raw: string | Uint8Array): PrivateKeyKind {
  const text = typeof raw === 'string' ? raw : (utf8(raw) ?? null);
  if (text === null) return 'unknown';
  const envelope = extractPemEnvelope(text);
  if (envelope === null) return 'unknown';
  const { label, inner } = envelope;

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
  return classifyDer(u8, label);
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
