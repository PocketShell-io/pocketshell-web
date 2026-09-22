import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  bytesToBase64,
  decodePublicKeyBlob,
  knownHostsToken,
  verifyHostKeyPin,
} from '@pocketshell/core';

// The vendored shared core (desktop src/shared/knownHostsCore.ts): the
// reference implementations for base64 and blob layout are Node's Buffer —
// the desktop's KnownHosts.ts stores exactly what Buffer.toString('base64')
// produces, so the browser-side pin comparison must agree byte for byte.

describe('knownHostsToken', () => {
  it('keys the default port as the bare hostname', () => {
    expect(knownHostsToken('devbox.example.com')).toBe('devbox.example.com');
    expect(knownHostsToken('devbox.example.com', 22)).toBe('devbox.example.com');
  });

  it('keys other ports as [host]:port — pins never collide across ports', () => {
    expect(knownHostsToken('127.0.0.1', 3205)).toBe('[127.0.0.1]:3205');
    expect(knownHostsToken('127.0.0.1', 22)).not.toBe(knownHostsToken('127.0.0.1', 3205));
  });
});

describe('verifyHostKeyPin', () => {
  const pin = { keyType: 'ssh-ed25519', keyB64: 'QUJD' };

  it('no stored pin is unknown', () => {
    expect(verifyHostKeyPin(undefined, 'ssh-ed25519', 'QUJD')).toBe('unknown');
  });

  it('same type and key is trusted', () => {
    expect(verifyHostKeyPin(pin, 'ssh-ed25519', 'QUJD')).toBe('trusted');
  });

  it('a different key or type is a mismatch — never silently replaced', () => {
    expect(verifyHostKeyPin(pin, 'ssh-ed25519', 'WFZa')).toBe('mismatch');
    expect(verifyHostKeyPin(pin, 'ssh-rsa', 'QUJD')).toBe('mismatch');
  });
});

function ed25519Blob(keyData: Buffer): Buffer {
  const type = Buffer.from('ssh-ed25519', 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(type.length, 0);
  return Buffer.concat([len, type, keyData]);
}

describe('decodePublicKeyBlob', () => {
  it('reads the RFC 4251 type string and base64s the whole blob', () => {
    const blob = ed25519Blob(Buffer.alloc(32, 7));
    const decoded = decodePublicKeyBlob(blob);
    expect(decoded.keyType).toBe('ssh-ed25519');
    // The known_hosts third field is the base64 of EXACTLY this blob.
    expect(decoded.keyB64).toBe(blob.toString('base64'));
  });

  it('degenerate blobs degrade to an unknown type, key bytes preserved', () => {
    const short = Buffer.from('ab', 'utf8');
    expect(decodePublicKeyBlob(short)).toEqual({ keyType: 'unknown', keyB64: short.toString('base64') });

    const zeroLen = Buffer.concat([Buffer.alloc(4), Buffer.from('zz', 'utf8')]);
    expect(decodePublicKeyBlob(zeroLen)).toEqual({ keyType: 'unknown', keyB64: zeroLen.toString('base64') });

    // Declared length exceeds the actual tail.
    const len = Buffer.alloc(4);
    len.writeUInt32BE(99, 0);
    const truncated = Buffer.concat([len, Buffer.from('ssh-ed25519', 'utf8')]);
    expect(decodePublicKeyBlob(truncated).keyType).toBe('unknown');
  });
});

describe('bytesToBase64', () => {
  it('matches Node Buffer base64 for every residue class and sizes around them', () => {
    const deterministic = (n: number): Buffer => {
      const out = Buffer.alloc(n);
      for (let i = 0; i < n; i++) out[i] = (i * 37 + 11) % 256;
      return out;
    };
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 32, 51, 255, 256]) {
      const bytes = deterministic(n);
      expect(bytesToBase64(new Uint8Array(bytes))).toBe(bytes.toString('base64'));
    }
  });
});
