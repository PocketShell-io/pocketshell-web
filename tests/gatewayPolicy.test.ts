import { describe, expect, it } from 'vitest';
import { describeApplyFailure, gatewayAuthInvocation, parseGatewayAuthReport } from '../src/vault/gatewayPolicy';

// The web half of the W5 contract: `pocketshell-link gateway-auth set
// --policy … --keys-stdin --json`, vault PUBLIC keys on stdin (comment
// vault:<keyId>), one JSON line back.

const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl some@laptop';

describe('gateway auth policy apply', () => {
  it('sends the bound vault key with a vault:<keyId> comment for managed and both', () => {
    for (const policy of ['managed', 'both'] as const) {
      const inv = gatewayAuthInvocation(policy, [{ keyId: 'kid123', publicKey: ED }]);
      expect(inv.command).toBe(`pocketshell-link gateway-auth set --policy ${policy} --keys-stdin --json`);
      expect(inv.stdin).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl vault:kid123\n');
    }
  });

  it('host clears the managed set; keys never ride the command line', () => {
    const inv = gatewayAuthInvocation('host', [{ keyId: 'kid', publicKey: ED }]);
    expect(inv.stdin).toBe('');
    expect(gatewayAuthInvocation('managed', [{ keyId: 'kid', publicKey: ED }]).command).not.toContain('AAAA');
  });

  it('parses the --json answer and refuses anything else', () => {
    const r = parseGatewayAuthReport(
      'noise\n{"policy":"managed","source":"configured","endpoint":"exec","managed_keys":[{"type":"ssh-ed25519","fingerprint":"SHA256:x","comment":"vault:kid"}]}\n',
    );
    expect(r).toEqual({
      policy: 'managed',
      source: 'configured',
      endpoint: 'exec',
      managedKeys: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:x', comment: 'vault:kid' }],
    });
    expect(parseGatewayAuthReport('{"policy":"weird"}')).toBeNull();
    expect(parseGatewayAuthReport('not json')).toBeNull();
  });

  it('explains an old host agent and a refusal', () => {
    expect(describeApplyFailure(127, 'sh: pocketshell-link: not found')).toMatch(/Update the PocketShell host agent/);
    expect(describeApplyFailure(1, 'refused: RSA key shorter than 2048 bits')).toBe('The host refused the policy: refused: RSA key shorter than 2048 bits.');
  });
});
