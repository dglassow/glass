/**
 * Ribbon pin/order model — which widgets the user docked on the right-side
 * ribbon, and in what order. Pure + framework-free (same pattern as
 * update-policy.ts) so it's unit-tested headlessly; persistence and DOM stay
 * with the caller (ribbon.ts).
 *
 * Ids the user pinned are kept verbatim even when no such widget is currently
 * registered: a widget can disappear across an app update (or exist only on a
 * newer version) and the user's arrangement must survive the round trip rather
 * than being silently pruned. Rendering intersects with what's actually
 * available via `visiblePinned`.
 */

export interface RibbonState {
  /** Widget ids the user pinned, in display order (top → bottom). */
  pinned: string[];
}

export function emptyRibbonState(): RibbonState {
  return { pinned: [] };
}

/** Parse a persisted blob (untrusted: localStorage survives app swaps). */
export function parseRibbonState(raw: string | null): RibbonState {
  if (!raw) return emptyRibbonState();
  try {
    const p = JSON.parse(raw) as { pinned?: unknown };
    if (!Array.isArray(p.pinned)) return emptyRibbonState();
    // Strings only, de-duplicated, bounded — a corrupt blob can't balloon the UI.
    const seen = new Set<string>();
    const pinned: string[] = [];
    for (const id of p.pinned) {
      if (typeof id === "string" && id.length > 0 && id.length <= 64 && !seen.has(id)) {
        seen.add(id);
        pinned.push(id);
      }
      if (pinned.length >= 128) break;
    }
    return { pinned };
  } catch {
    return emptyRibbonState();
  }
}

/** Pin `id` (appends at the end). Pinning an already-pinned id is a no-op. */
export function pin(state: RibbonState, id: string): RibbonState {
  if (state.pinned.includes(id)) return state;
  return { pinned: [...state.pinned, id] };
}

/** Unpin `id`. Unknown ids are a no-op. */
export function unpin(state: RibbonState, id: string): RibbonState {
  if (!state.pinned.includes(id)) return state;
  return { pinned: state.pinned.filter((p) => p !== id) };
}

/** Move `id` by `delta` positions (negative = up/earlier), clamped in range. */
export function move(state: RibbonState, id: string, delta: number): RibbonState {
  const from = state.pinned.indexOf(id);
  if (from < 0) return state;
  const to = Math.min(state.pinned.length - 1, Math.max(0, from + Math.trunc(delta)));
  if (to === from) return state;
  const pinned = [...state.pinned];
  pinned.splice(from, 1);
  pinned.splice(to, 0, id);
  return { pinned };
}

/** Pinned ids that are actually available right now, in the user's order. */
export function visiblePinned(state: RibbonState, available: ReadonlySet<string>): string[] {
  return state.pinned.filter((id) => available.has(id));
}
