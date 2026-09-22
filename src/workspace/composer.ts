/**
 * The session composer's logic, framework-free: which agent a tab runs,
 * what the slash palette offers, what an accepted row inserts, and how a
 * sent line reaches the PTY. The Vue view is chrome around this.
 *
 * Everything hard lives in the vendored shared modules: delivery framing
 * and timing in `shared/composerSend` (bracketed paste, separate submit
 * key, the 250 ms Enter-settling delay), the command catalog in
 * `shared/agentCommands`, the engine vocabulary in `shared/aplexerParsers`.
 * This file is only the wiring contract between them, pinned by
 * tests/workspaceComposer.test.ts.
 */
import { agentKindFromEngine } from '@pocketshell/core';
import {
  composerAgentKind,
  deliverPayload,
  type ComposerAgentKind,
} from '@pocketshell/core';
import {
  filteredCommands,
  insertionTextFor,
  type AgentCommand,
} from '@pocketshell/core';

/** The engine a tab runs, narrowed to the engines the composer can talk to. */
export function liveAgentKind(engine: string | null | undefined): ComposerAgentKind | null {
  return composerAgentKind(agentKindFromEngine((engine ?? '').trim()));
}

/**
 * The palette rows for the input as typed. Open only while the input is
 * exactly a slash token — `/`, `/cl` — never once a space lands (the user
 * is past picking, they are typing an argument), and never without a known
 * engine: a shell pane gets no dropdown, per the catalog's own contract.
 */
export function paletteFor(input: string, agent: ComposerAgentKind | null): AgentCommand[] {
  if (agent === null) return [];
  if (!/^\/\S*$/.test(input)) return [];
  return filteredCommands(agent, input.slice(1));
}

/** The text an accepted palette row leaves in the input. */
export function acceptedInput(command: AgentCommand): string {
  return insertionTextFor(command);
}

/**
 * Deliver one composed line: framed body, pause, submit key — the shared
 * delivery the desktop and the phone both ride. Returns false, with the
 * caller expected to keep the text, when the tab's channel refused the
 * body, so a dead session can never silently eat a typed prompt.
 *
 * `sendRoute`'s raw/agent-payload split exists to give Codex the long
 * submit delay; `deliverPayload` already takes the safe end of that range
 * for every send, so there is no slower path left to choose between here.
 * The web contract is "always the safe path"; the route vocabulary stays
 * pinned in tests.
 */
export async function sendComposerLine(
  input: string,
  write: (data: string) => Promise<boolean>,
): Promise<boolean> {
  if (input.trim() === '') return false;
  return deliverPayload(input, { write });
}
