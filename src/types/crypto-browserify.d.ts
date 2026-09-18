/** crypto-browserify ships no types; ssh2's shim only needs a loose shape. */
declare module 'crypto-browserify' {
  type AnyFn = (...args: any[]) => any;
  const crypto: {
    createCipheriv: AnyFn;
    createDecipheriv: AnyFn;
    createECDH: AnyFn;
    createDiffieHellman: AnyFn;
    createDiffieHellmanGroup: AnyFn;
    createHash: AnyFn;
    createHmac: AnyFn;
    createSign: AnyFn;
    createVerify: AnyFn;
    getCiphers: () => string[];
    randomBytes: AnyFn;
    randomFillSync: AnyFn;
  };
  export default crypto;
}
