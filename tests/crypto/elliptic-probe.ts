/**
 * Counting probe in front of the REAL elliptic library. The test config
 * aliases bare 'elliptic' here; the genuine package is loaded through its
 * deep path (which the exact-match alias deliberately does not catch), its
 * EC/EdDSA classes are wrapped at the prototype level, and everything is
 * re-exported unchanged. Suites assert the ECDSA counter stays at ZERO —
 * a nonzero count means some code path reached elliptic's ECDSA signer.
 *
 * This is instrumentation, not a mock: every call still executes the real
 * library, and nothing the suites test positively (RSA/Ed25519 signing)
 * goes through elliptic at all.
 */
import * as ellipticDeep from 'elliptic/lib/elliptic.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const impl: any = (ellipticDeep as any).default ?? ellipticDeep;

export const ellipticProbe = {
  ecSignCalls: 0,
  eddsaSignCalls: 0,
};

const EC = impl.ec;
if (EC && typeof EC.prototype?.sign === 'function') {
  const origEcSign = EC.prototype.sign;
  EC.prototype.sign = function (...args: unknown[]) {
    ellipticProbe.ecSignCalls += 1;
    return origEcSign.apply(this, args);
  };
}

const EdDSA = impl.eddsa;
if (EdDSA && typeof EdDSA.prototype?.sign === 'function') {
  const origEdSign = EdDSA.prototype.sign;
  EdDSA.prototype.sign = function (...args: unknown[]) {
    ellipticProbe.eddsaSignCalls += 1;
    return origEdSign.apply(this, args);
  };
}

export const ec = impl.ec;
export const eddsa = impl.eddsa;
export default impl;
