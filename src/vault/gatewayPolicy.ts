/**
 * "Apply to host": push a host's gateway auth policy and its vault PUBLIC
 * key to the host agent (pocketshell-gateway W5 contract):
 *
 *   pocketshell-link gateway-auth set --policy host|managed|both --keys-stdin --json
 *
 * run over an already-authenticated SSH session, with authorized_keys lines
 * on stdin replacing the whole managed set (`host` sends none, clearing it).
 * Each line carries the comment `vault:<keyId>`. The host answers one JSON
 * line with the policy and the managed keys' fingerprints, never key bytes.
 * There is deliberately no gateway-relayed path: the gateway only proves
 * account ownership.
 */
import type { GatewayAuthPolicy } from '@pocketshell/core';

export const GATEWAY_AUTH_COMMAND = 'pocketshell-link gateway-auth set';

export interface GatewayAuthReport {
  policy: GatewayAuthPolicy;
  source: string;
  endpoint: string;
  managedKeys: { type: string; fingerprint: string; comment: string }[];
}

/** The command and stdin for a policy and the vault keys it should trust. */
export function gatewayAuthInvocation(
  policy: GatewayAuthPolicy,
  keys: { keyId: string; publicKey: string }[],
): { command: string; stdin: string } {
  const lines =
    policy === 'host'
      ? []
      : keys.map(({ keyId, publicKey }) => {
          const [type, blob] = publicKey.trim().split(/\s+/);
          if (!type || !blob) throw new Error('A vault public key is malformed.');
          return `${type} ${blob} vault:${keyId}`;
        });
  return {
    command: `${GATEWAY_AUTH_COMMAND} --policy ${policy} --keys-stdin --json`,
    stdin: lines.length > 0 ? `${lines.join('\n')}\n` : '',
  };
}

/** Parse the host's `--json` line; null when it is not that shape. */
export function parseGatewayAuthReport(stdout: string): GatewayAuthReport | null {
  const line = stdout.trim().split('\n').pop() ?? '';
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (raw.policy !== 'host' && raw.policy !== 'managed' && raw.policy !== 'both') return null;
    const keys = Array.isArray(raw.managed_keys) ? raw.managed_keys : [];
    return {
      policy: raw.policy,
      source: String(raw.source ?? ''),
      endpoint: String(raw.endpoint ?? ''),
      managedKeys: keys
        .filter((k): k is Record<string, unknown> => typeof k === 'object' && k !== null)
        .map((k) => ({ type: String(k.type ?? ''), fingerprint: String(k.fingerprint ?? ''), comment: String(k.comment ?? '') })),
    };
  } catch {
    return null;
  }
}

/** What the user reads after an apply attempt. */
export function describeApplyFailure(exitCode: number | null, stderr: string): string {
  if (exitCode === 127 || /not found/i.test(stderr)) {
    return 'This host has no pocketshell-link with gateway policy support yet. Update the PocketShell host agent, then apply again.';
  }
  const detail = stderr.trim().split('\n').pop();
  return `The host refused the policy${detail ? `: ${detail}` : ''}.`;
}
