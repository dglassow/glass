/**
 * Messages-dock agent selection — which bridge Mac the panel is reading, and
 * what happens when the fleet changes under it. Pure + framework-free
 * (update-policy pattern) so it's unit-tested headlessly; the DOM stays in
 * imessage-panel.ts.
 *
 * The rule this module encodes: two Macs signed into the SAME iMessage
 * account are mirrors — failing over between them is safe and should be
 * seamless. Macs on DIFFERENT accounts (or accounts we can't determine) are
 * different mailboxes — the panel must never hop between them silently,
 * because "reply into the open thread" would suddenly ride a different
 * identity. Unknown-vs-unknown counts as different: we can't prove they
 * match, so we fail to the safe side.
 */

export interface BridgeAgent {
  id: string;
  name: string;
  /** Signed-in iMessage account, when the bridge could detect it. */
  account?: string;
}

export type AgentPick =
  | {
      agent: BridgeAgent;
      /** The previously selected agent vanished and this one replaced it. */
      failedOver: boolean;
      /** The replacement serves a different (or unprovable) account — the
       *  caller must reset any open thread and say so, never continue. */
      changedAccount: boolean;
    }
  | null;

export function sameAccount(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/**
 * Choose the agent to read from after a fleet change. Stability first: the
 * current selection is kept whenever it's still available. On loss, prefer a
 * same-account mirror (seamless), else the first available (explicit reset).
 */
export function pickAgent(
  currentId: string | null,
  currentAccount: string | undefined,
  agents: readonly BridgeAgent[],
): AgentPick {
  if (agents.length === 0) return null;
  const current = currentId !== null ? agents.find((a) => a.id === currentId) : undefined;
  if (current) return { agent: current, failedOver: false, changedAccount: false };
  const mirror = agents.find((a) => sameAccount(a.account, currentAccount));
  if (mirror) return { agent: mirror, failedOver: currentId !== null, changedAccount: false };
  const first = agents[0]!;
  // No prior selection at all is a fresh pick, not a failover or a change.
  if (currentId === null) return { agent: first, failedOver: false, changedAccount: false };
  return { agent: first, failedOver: true, changedAccount: true };
}

/**
 * Display labels for the device picker. The account is part of the label
 * whenever it's known — with several Macs on several accounts, "which
 * mailbox am I in" must be legible at a glance; with one account everywhere
 * it's harmless confirmation.
 */
export function agentLabel(agent: BridgeAgent): string {
  return agent.account !== undefined ? `${agent.name} — ${agent.account}` : agent.name;
}
