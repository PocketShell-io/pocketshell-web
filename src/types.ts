/**
 * The synced host entry, mirrored from the desktop app
 * (pocketshell-desktop src/shared/types.ts HostEntry). The sync payload the
 * envelope encrypts is `{ hosts: HostEntry[] }` — see the desktop repo's
 * src/shared/syncMerge.ts. identityFile is a PATH on the machine that pushed
 * the entry; the key material never syncs, so a web session cannot use it
 * directly — the user attaches a key or password per host in the browser.
 */
export interface HostEntry {
  name: string;
  hostname: string;
  port: number;
  user: string;
  identityFile: string | null;
  proxyJump: string | null;
  forwardAgent: boolean;
  fromConfig: boolean;
}

/** `GET /settings/{slot}` response. */
export interface PulledSlot {
  slot: string;
  version: number;
  updatedAt: string;
  size: number;
  data: string;
}

/** The zero-knowledge envelope (docs in aws-infra sandbox/pocketshell-sync). */
export interface SyncEnvelope {
  v: number;
  kdf: string;
  iter: number;
  salt: string;
  iv: string;
  ct: string;
}
