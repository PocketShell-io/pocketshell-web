/**
 * Browser stand-in for ssh2's node-only SSH-agent support (agent.js pulls in
 * net/child_process and dereferences __dirname at module scope). The direct
 * session never configures an agent, so every entry point is inert.
 */
export class AgentContext {}

export function createAgent(): undefined {
  return undefined;
}

export function isAgent(): boolean {
  return false;
}
