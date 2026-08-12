/**
 * First-run welcome + role picker (plain DOM, no framework).
 *
 * The viewer no longer drops the user straight into a hub-URL form: on first
 * launch it explains what Glass is and asks which ROLE this machine plays —
 * Standalone (everything local), Hub (the fleet's center, one per fleet), or
 * Spoke (join an existing hub). The choice is persisted by main.ts under
 * 'glass.role' and can be revisited at any time from the app's File menu or
 * the sidebar gear (both funnel back into showOnboarding).
 *
 * Contract: showOnboarding(app, { onPick }). onPick may be async — while it
 * runs the cards lock and the chosen card shows a busy state; if it THROWS,
 * the error message is shown inline and the picker unlocks (this is how
 * "Standalone needs the desktop app" and backend-start failures surface).
 */

export type Role = "standalone" | "hub" | "spoke";

export interface OnboardingOptions {
  onPick: (role: Role) => void | Promise<void>;
  /** Optional message shown immediately (e.g. why a stored role failed to start). */
  error?: string;
}

interface CardSpec {
  role: Role;
  title: string;
  desc: string;
  tag?: string;
}

const CARDS: CardSpec[] = [
  {
    role: "standalone",
    title: "Standalone",
    desc: "Just this Mac. Glass runs everything locally.",
    tag: "recommended",
  },
  {
    role: "hub",
    title: "Hub",
    desc: "The center of your fleet — other devices connect here. Only one hub.",
    tag: "one per fleet",
  },
  {
    role: "spoke",
    title: "Spoke",
    desc: "Join an existing hub. Share this Mac's shells with your fleet.",
  },
];

export function showOnboarding(app: HTMLElement, opts: OnboardingOptions): void {
  app.replaceChildren();

  const screen = document.createElement("div");
  screen.className = "onboard";
  const panel = document.createElement("div");
  panel.className = "onboard-panel";

  const title = document.createElement("h1");
  title.textContent = "Glass";

  const narrative = document.createElement("p");
  narrative.className = "onboard-narrative";
  narrative.textContent =
    "Your Macs' terminals, unified into one place. Open shells on any machine in your " +
    "fleet, watch them live, and pick up right where you left off. Add your phone later " +
    "and carry the whole fleet in your pocket.";

  const prompt = document.createElement("p");
  prompt.className = "onboard-prompt";
  prompt.textContent = "how should this machine run? (you can change this any time from the File menu)";

  const cardRow = document.createElement("div");
  cardRow.className = "role-cards";
  cardRow.setAttribute("role", "radiogroup");
  cardRow.setAttribute("aria-label", "choose a role");

  const error = document.createElement("p");
  error.className = "onboard-error";
  if (opts.error) error.textContent = opts.error;

  const cards: HTMLButtonElement[] = [];
  let busy = false;

  const pick = (spec: CardSpec, card: HTMLButtonElement): void => {
    if (busy) return;
    busy = true;
    error.textContent = "";
    for (const c of cards) c.disabled = c !== card;
    card.classList.add("busy");
    void Promise.resolve()
      .then(() => opts.onPick(spec.role))
      .catch((err: unknown) => {
        error.textContent = err instanceof Error ? err.message : String(err);
        busy = false;
        card.classList.remove("busy");
        for (const c of cards) c.disabled = false;
        card.focus();
      });
  };

  for (const spec of CARDS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "role-card";
    card.dataset["role"] = spec.role;

    const head = document.createElement("div");
    head.className = "role-head";
    const cardTitle = document.createElement("span");
    cardTitle.className = "role-title";
    cardTitle.textContent = spec.title;
    head.append(cardTitle);
    if (spec.tag) {
      const tag = document.createElement("span");
      tag.className = "role-tag";
      tag.textContent = spec.tag;
      head.append(tag);
    }

    const desc = document.createElement("p");
    desc.className = "role-desc";
    desc.textContent = spec.desc;

    card.append(head, desc);
    card.addEventListener("click", () => pick(spec, card));
    cards.push(card);
    cardRow.append(card);
  }

  // Arrow keys cycle between the cards; Enter/Space on a focused card selects
  // it (native <button> behaviour, so no extra handler needed for that).
  cardRow.addEventListener("keydown", (ev) => {
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(ev.key)) return;
    ev.preventDefault();
    const dir = ev.key === "ArrowRight" || ev.key === "ArrowDown" ? 1 : -1;
    const current = cards.findIndex((c) => c === document.activeElement);
    const next = cards[(current + dir + cards.length) % cards.length];
    next?.focus();
  });

  panel.append(title, narrative, prompt, cardRow, error);
  screen.append(panel);
  app.append(screen);
  cards[0]?.focus();
}
