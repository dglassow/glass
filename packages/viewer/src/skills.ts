/**
 * User skills — small user-authored scripts pinned to the ribbon and executed
 * in the CURRENTLY FOCUSED session by sending their text as input, exactly as
 * if typed/pasted there. That's the whole trust model: a skill can do nothing
 * the keyboard can't, on a session the user is already attached to. Skills
 * never run on their own, never target an unfocused session, and never leave
 * the device (localStorage only).
 *
 * Pure + framework-free (update-policy pattern) so it's unit-tested headlessly;
 * persistence and DOM live in skills-ui.ts.
 */

export interface Skill {
  /** Stable identity; also the ribbon widget id, so pins survive restarts. */
  id: string;
  name: string;
  /** Short glyph shown on the ribbon button. */
  icon: string;
  /** The text sent to the focused session. */
  script: string;
  /** Append a newline (run it) when the script doesn't already end with one. */
  pressEnter: boolean;
}

export const MAX_SKILLS = 128;
export const MAX_SCRIPT = 65536;

/** Parse a persisted blob (untrusted: localStorage survives app swaps). */
export function parseSkills(raw: string | null): Skill[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const seen = new Set<string>();
    const out: Skill[] = [];
    for (const e of arr) {
      if (typeof e !== "object" || e === null) continue;
      const { id, name, icon, script, pressEnter } = e as Record<string, unknown>;
      if (typeof id !== "string" || id.length === 0 || id.length > 64 || seen.has(id)) continue;
      if (typeof script !== "string") continue;
      seen.add(id);
      out.push({
        id,
        name: (typeof name === "string" && name.trim() ? name : "unnamed").slice(0, 64),
        icon: (typeof icon === "string" && icon.trim() ? icon : "»").slice(0, 8),
        script: script.slice(0, MAX_SCRIPT),
        pressEnter: pressEnter !== false,
      });
      if (out.length >= MAX_SKILLS) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** The exact bytes a skill sends to the focused session. */
export function skillInput(skill: Skill): string {
  if (!skill.pressEnter) return skill.script;
  return skill.script.endsWith("\n") ? skill.script : `${skill.script}\n`;
}

/** Upsert by id (append when new), enforcing the collection bound. */
export function upsertSkill(skills: Skill[], skill: Skill): Skill[] {
  const i = skills.findIndex((s) => s.id === skill.id);
  if (i >= 0) return [...skills.slice(0, i), skill, ...skills.slice(i + 1)];
  if (skills.length >= MAX_SKILLS) return skills;
  return [...skills, skill];
}

export function deleteSkill(skills: Skill[], id: string): Skill[] {
  return skills.filter((s) => s.id !== id);
}
