/**
 * The OpenSSH-style display fingerprint of a host key: `SHA256:<base64>`
 * (padding stripped), the string both the desktop's terminal and OpenSSH's
 * known_hosts prompt would show for the same key — so a fingerprint read
 * over the phone matches what either client puts on screen.
 *
 * WebCrypto is a browser given here; the desktop main never shows a
 * fingerprint (it compares key blobs), so this stays a web-side helper
 * instead of riding the platform-free shared core.
 */
export async function sha256Fingerprint(keyBlob: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', keyBlob as unknown as ArrayBuffer);
  const bytes = new Uint8Array(digest);
  let bits = '';
  for (const b of bytes) bits += String.fromCharCode(b);
  return `SHA256:${btoa(bits).replace(/=+$/, '')}`;
}
