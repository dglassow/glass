/**
 * Skills editor — create/edit/delete the user's skills (skills.ts model).
 * Reached from the ribbon's customize dialog ("Skills…"). Two views in one
 * panel: the list, and an edit form. Every change persists immediately and is
 * reported via onChange so the ribbon can (un)register the matching widgets.
 */
import { deleteSkill, parseSkills, upsertSkill, MAX_SCRIPT, type Skill } from "./skills.js";

const KEY = "glass.skills";

export function loadSkills(): Skill[] {
  try {
    return parseSkills(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

function saveSkills(skills: Skill[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(skills));
  } catch {
    /* private mode / quota — edits just won't persist */
  }
}

let openOverlay: HTMLElement | undefined;

/** Open the editor. `onChange(skill|null, id)` fires after each save/delete. */
export function openSkillsEditor(onChange: (changed: Skill | null, id: string) => void): void {
  openOverlay?.remove();
  let skills = loadSkills();

  const o = document.createElement("div");
  o.className = "tset-overlay";
  const panel = document.createElement("div");
  panel.className = "tset-panel";
  panel.setAttribute("role", "dialog");
  panel.tabIndex = -1;
  const close = (): void => {
    o.remove();
    openOverlay = undefined;
  };
  o.addEventListener("mousedown", (ev) => {
    if (ev.target === o) close();
  });
  panel.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });

  const title = document.createElement("h2");
  title.className = "tset-title";
  const body = document.createElement("div");
  body.className = "ribbon-config";
  const foot = document.createElement("div");
  foot.className = "ribbon-config-foot";
  panel.append(title, body, foot);

  function showList(): void {
    title.textContent = "skills";
    body.replaceChildren();
    foot.replaceChildren();
    if (skills.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ribbon-config-empty";
      empty.textContent =
        "A skill is a script you write; its button on the ribbon types the script into the focused session — nothing more, nothing on its own.";
      body.append(empty);
    }
    for (const s of skills) {
      const row = document.createElement("div");
      row.className = "ribbon-config-row";
      const icon = document.createElement("span");
      icon.className = "ribbon-config-icon";
      icon.textContent = s.icon;
      const name = document.createElement("span");
      name.className = "ribbon-config-name";
      name.textContent = s.name;
      const edit = document.createElement("button");
      edit.textContent = "Edit";
      edit.addEventListener("click", () => showEdit(s));
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        skills = deleteSkill(skills, s.id);
        saveSkills(skills);
        onChange(null, s.id);
        showList();
      });
      row.append(icon, name, edit, del);
      body.append(row);
    }
    const add = document.createElement("button");
    add.className = "update-banner-btn";
    add.textContent = "New skill";
    add.addEventListener("click", () =>
      showEdit({ id: `skill-${crypto.randomUUID()}`, name: "", icon: "»", script: "", pressEnter: true }),
    );
    const closeBtn = document.createElement("button");
    closeBtn.className = "update-banner-btn";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", close);
    foot.append(add, closeBtn);
  }

  function showEdit(base: Skill): void {
    const isNew = !skills.some((s) => s.id === base.id);
    title.textContent = isNew ? "new skill" : "edit skill";
    body.replaceChildren();
    foot.replaceChildren();

    const field = (label: string, input: HTMLElement): HTMLElement => {
      const wrap = document.createElement("label");
      wrap.className = "skill-field";
      const cap = document.createElement("span");
      cap.textContent = label;
      wrap.append(cap, input);
      return wrap;
    };
    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.value = base.name;
    nameIn.maxLength = 64;
    nameIn.placeholder = "e.g. git status";
    const iconIn = document.createElement("input");
    iconIn.type = "text";
    iconIn.value = base.icon;
    iconIn.maxLength = 8;
    iconIn.className = "skill-icon-input";
    const scriptIn = document.createElement("textarea");
    scriptIn.value = base.script;
    scriptIn.maxLength = MAX_SCRIPT;
    scriptIn.rows = 8;
    scriptIn.spellcheck = false;
    scriptIn.placeholder = "typed into the focused session when you click the button";
    const enterIn = document.createElement("input");
    enterIn.type = "checkbox";
    enterIn.checked = base.pressEnter;
    const enterWrap = document.createElement("label");
    enterWrap.className = "skill-enter";
    enterWrap.append(enterIn, document.createTextNode(" press Enter after (run it)"));

    const save = document.createElement("button");
    save.className = "update-banner-btn";
    save.textContent = "Save";
    save.addEventListener("click", () => {
      const skill: Skill = {
        id: base.id,
        name: nameIn.value.trim().slice(0, 64) || "unnamed",
        icon: iconIn.value.trim().slice(0, 8) || "»",
        script: scriptIn.value.slice(0, MAX_SCRIPT),
        pressEnter: enterIn.checked,
      };
      skills = upsertSkill(skills, skill);
      saveSkills(skills);
      onChange(skill, skill.id);
      showList();
    });
    const back = document.createElement("button");
    back.className = "update-banner-btn";
    back.textContent = "Cancel";
    back.addEventListener("click", showList);

    body.append(field("name", nameIn), field("icon", iconIn), field("script", scriptIn), enterWrap);
    foot.append(save, back);
    nameIn.focus();
  }

  showList();
  o.append(panel);
  document.body.append(o);
  openOverlay = o;
  panel.focus();
}
