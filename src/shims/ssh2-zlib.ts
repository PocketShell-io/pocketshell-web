/**
 * Browser stand-in for node's zlib as ssh2 consumes it. SSH compression is
 * not negotiated (the direct session keeps the default `none`), but ssh2's
 * protocol/zlib.js evaluates `createInflate()._handle.constructor` at module
 * load, so import itself needs a plausible shape. Every factory throws if
 * anything ever really tries to compress.
 */
class ZlibHandleStub {}

function unsupported(name: string): () => never {
  return () => {
    throw new Error(`zlib.${name} is not supported in the browser build`);
  };
}

export function createInflate(): { _handle: ZlibHandleStub } {
  return { _handle: new ZlibHandleStub() };
}

export const createDeflate = unsupported('createDeflate');
export const createInflateRaw = unsupported('createInflateRaw');
export const createDeflateRaw = unsupported('createDeflateRaw');
export const createGzip = unsupported('createGzip');
export const createGunzip = unsupported('createGunzip');

export const constants = {
  DEFLATE: 8,
  INFLATE: 9,
  Z_DEFAULT_CHUNK: 16384,
  Z_DEFAULT_COMPRESSION: -1,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_DEFAULT_STRATEGY: 0,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_PARTIAL_FLUSH: 1,
};
