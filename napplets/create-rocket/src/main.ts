import { identity, outbox, themeGet, themeOnChanged } from "@napplet/sdk";
import { gsap } from "gsap";
import "./styles.css";
import { buildIgnitionTemplate, hasObservedRocketIdentifier, normalizeRocketIdentifier, publishIgnition, rocketIdentifier, validateDraft, type EventTemplate, type RocketDraft } from "./rocket";
import { problemChoices, repositoryChoices, ROOT_PROBLEM_COORDINATE, type ChoiceResult, type RocketReferenceChoice } from "./selections";

declare global { interface Window { napplet?: { theme?: { get?: unknown }; identity?: { getPublicKey?: unknown; onChanged?: unknown } } } }
const app = document.querySelector<HTMLElement>("#app") ?? (() => { throw new Error("Application root is missing."); })();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let pending: EventTemplate | undefined;

app.innerHTML = `<article class="sheet">
  <header class="masthead"><div><span class="eyebrow">Sovereign Economic Community</span><h1>Ignite a rocket</h1><p>Define its identity and mission. Shell signs and routes the ignition event.</p></div><span class="badge">31108</span></header>
  <section id="editor" aria-labelledby="details-title"><h2 id="details-title">Rocket details</h2>
    <label>Rocket Name <input id="identifier" autocomplete="off" placeholder="MY_ROCKET" aria-describedby="identifier-hint"></label><small id="identifier-hint" aria-live="polite">Checking observed rockets in background. You can continue.</small>
    <label>Mission <textarea id="mission" maxlength="139" rows="4" placeholder="Why should this rocket exist? (optional)"></textarea></label><small><output id="mission-count">0</output>/139 characters</small>
    <section class="references" aria-labelledby="references-title"><div class="section-heading"><div><h2 id="references-title">Problem and repository</h2><p>Choose a problem from the NOSTROCKET tree and a repository from your connected account.</p></div><button id="retry-references" class="text-button" type="button" hidden>Try again</button></div>
      <div class="reference-grid">
        <fieldset><legend>Problem</legend><div id="problem-options" class="choice-list" aria-live="polite" aria-busy="true"><p class="choice-state">Loading problem tree…</p></div></fieldset>
        <fieldset><legend>Git repository</legend><div id="repository-options" class="choice-list" aria-live="polite" aria-busy="true"><p class="choice-state">Loading your git repositories…</p></div></fieldset>
      </div>
      <output id="reference-status" class="reference-status" aria-live="polite"></output>
    </section>
    <div class="action"><output id="status" aria-live="polite">Draft stays local until preview and confirmation.</output><button id="preview" type="button">Review ignition <span>↗</span></button></div>
  </section>
  <section id="review" hidden aria-labelledby="review-title"><span class="eyebrow">Final check</span><h2 id="review-title">Publish this ignition?</h2><p>Publishing creates a public, signed kind 31108 event. NOSTROCKET is a structural reference only; no link to it is added.</p><pre id="event-preview"></pre><div class="review-actions"><button id="back" type="button">Back to edit</button><button id="publish" type="button">Publish rocket</button></div></section>
</article>`;

const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
const mission = document.querySelector<HTMLTextAreaElement>("#mission")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
const previewButton = document.querySelector<HTMLButtonElement>("#preview")!;
const publishButton = document.querySelector<HTMLButtonElement>("#publish")!;
const editor = document.querySelector<HTMLElement>("#editor")!;
const review = document.querySelector<HTMLElement>("#review")!;
const identifierInput = input("identifier");
const identifierHint = document.querySelector<HTMLElement>("#identifier-hint")!;
const problemOptions = document.querySelector<HTMLElement>("#problem-options")!;
const repositoryOptions = document.querySelector<HTMLElement>("#repository-options")!;
const referenceStatus = document.querySelector<HTMLOutputElement>("#reference-status")!;
const retryReferences = document.querySelector<HTMLButtonElement>("#retry-references")!;
const observedIdentifiers = new Set<string>();
const observedRelays = new Set<string>();
let identifierStreamActive = true;
let selectedProblem: RocketReferenceChoice | undefined;
let selectedRepository: RocketReferenceChoice | undefined;
let referenceLoad = 0;

function syncIdentifierValidation(): boolean {
  const identifier = identifierInput.value.trim();
  const duplicate = hasObservedRocketIdentifier(identifier, observedIdentifiers);
  identifierInput.setAttribute("aria-invalid", String(duplicate));
  identifierHint.dataset.state = duplicate ? "error" : "idle";
  if (duplicate) identifierHint.textContent = "Already used by an observed kind 31108 event.";
  else if (!identifier) identifierHint.textContent = identifierStreamActive ? "Checking observed rockets in background. You can continue." : "Required rocket name or identifier. Live uniqueness updates stopped.";
  else identifierHint.textContent = identifierStreamActive ? `Available among ${observedIdentifiers.size} observed rocket identifiers.` : `Available among ${observedIdentifiers.size} known identifiers. Live uniqueness updates stopped.`;
  return !duplicate;
}

function readDraft(): RocketDraft { return { identifier: input("identifier").value.trim(), mission: mission.value, problemCoordinate: selectedProblem?.coordinate ?? "", problemRelay: selectedProblem?.relay ?? "", repoCoordinate: selectedRepository?.coordinate ?? "", repoRelay: selectedRepository?.relay ?? "" }; }
function setStatus(message: string, state = "idle"): void { status.textContent = message; status.dataset.state = state; }
function showEditor(): void { review.hidden = true; editor.hidden = false; pending = undefined; if (!reducedMotion) gsap.fromTo(editor, { opacity: 0, x: -10 }, { opacity: 1, x: 0, duration: .28, ease: "power2.out" }); }

function showPreview(): void {
  const draft = readDraft();
  identifierInput.value = draft.identifier;
  const errors = validateDraft(draft);
  if (!syncIdentifierValidation()) errors.push("Identifier must be unique among observed kind 31108 events.");
  if (errors.length) { setStatus(errors.join(" "), "error"); return; }
  pending = buildIgnitionTemplate(draft, Math.floor(Date.now() / 1000));
  document.querySelector<HTMLElement>("#event-preview")!.textContent = JSON.stringify(pending, null, 2);
  editor.hidden = true; review.hidden = false;
  if (!reducedMotion) gsap.fromTo(review, { opacity: 0, x: 10 }, { opacity: 1, x: 0, duration: .32, ease: "power2.out" });
  publishButton.focus();
}

async function publish(): Promise<void> {
  if (!pending) { showEditor(); setStatus("Preview event again before publishing.", "error"); return; }
  const pendingIdentifier = pending.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
  if (hasObservedRocketIdentifier(pendingIdentifier, observedIdentifiers)) { showEditor(); setStatus("Identifier is now used by an observed kind 31108 event. Choose another identifier.", "error"); syncIdentifierValidation(); return; }
  publishButton.disabled = true; publishButton.textContent = "Publishing…";
  try {
    const targetRelays = Array.from(new Set([
      ...observedRelays,
      ...(selectedProblem?.relay ? [selectedProblem.relay] : []),
      ...(selectedRepository?.relay ? [selectedRepository.relay] : []),
    ]));
    const id = await publishIgnition(outbox.publish as Parameters<typeof publishIgnition>[0], pending, targetRelays.length ? {
      relays: targetRelays,
      toOutbox: false,
    } : undefined);
    review.innerHTML = `<span class="eyebrow">Ignition published</span><h2>Rocket launched.</h2><p>Signed event returned by shell:</p><code class="event-id">${id}</code>`;
    if (!reducedMotion) gsap.fromTo("#review > *", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .35, stagger: .06, ease: "power3.out" });
  } catch (error) {
    console.error("Rocket ignition publication failed", { identifier: input("identifier").value, error });
    publishButton.disabled = false; publishButton.textContent = "Publish rocket";
    const message = error instanceof Error ? error.message : "Rocket could not be published.";
    const errorLine = document.createElement("p"); errorLine.className = "review-error"; errorLine.setAttribute("role", "alert"); errorLine.textContent = message;
    review.querySelector(".review-error")?.remove(); review.querySelector(".review-actions")?.before(errorLine);
  }
}

mission.addEventListener("input", () => { document.querySelector<HTMLOutputElement>("#mission-count")!.value = String([...mission.value].length); });
identifierInput.addEventListener("input", syncIdentifierValidation);
previewButton.addEventListener("click", showPreview);
document.querySelector<HTMLButtonElement>("#back")!.addEventListener("click", showEditor);
publishButton.addEventListener("click", () => void publish());
editor.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "text") { event.preventDefault(); showPreview(); } });

function renderState(container: HTMLElement, message: string, state = "idle"): void {
  container.replaceChildren();
  container.setAttribute("aria-busy", "false");
  const line = document.createElement("p");
  line.className = "choice-state";
  line.dataset.state = state;
  line.textContent = message;
  container.append(line);
}

function renderChoices(container: HTMLElement, name: "problem" | "repository", choices: RocketReferenceChoice[]): void {
  container.replaceChildren();
  container.setAttribute("aria-busy", "false");
  for (const [index, choice] of choices.entries()) {
    const label = document.createElement("label");
    label.className = "choice";
    if (name === "problem") {
      label.classList.add("problem-choice");
      label.dataset.depth = String(choice.depth ?? 0);
      label.style.setProperty("--choice-depth", String(choice.depth ?? 0));
    }
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = name;
    radio.value = choice.coordinate;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      if (name === "problem") selectedProblem = choice;
      else selectedRepository = choice;
      referenceStatus.value = `${choice.title} selected as ${name === "problem" ? "problem" : "git repository"}.`;
    });
    const copy = document.createElement("span");
    copy.className = "choice-copy";
    const title = document.createElement("strong");
    title.textContent = choice.title;
    const summary = document.createElement("span");
    summary.textContent = choice.summary;
    copy.append(title, summary);
    label.append(radio, copy);
    container.append(label);
    if (!reducedMotion) gsap.fromTo(label, { opacity: 0, y: 7 }, { opacity: 1, y: 0, duration: .28, delay: Math.min(index, 8) * .035, ease: "expo.out" });
  }
}

async function loadReferences(pubkey?: string): Promise<void> {
  const load = ++referenceLoad;
  selectedProblem = undefined;
  selectedRepository = undefined;
  referenceStatus.value = "";
  retryReferences.hidden = true;
  problemOptions.setAttribute("aria-busy", "true");
  repositoryOptions.setAttribute("aria-busy", "true");
  renderState(problemOptions, "Loading problem tree…");
  renderState(repositoryOptions, "Loading your git repositories…");
  problemOptions.setAttribute("aria-busy", "true");
  repositoryOptions.setAttribute("aria-busy", "true");

  try {
    if (pubkey === undefined && typeof window.napplet?.identity?.getPublicKey !== "function") {
      renderState(problemOptions, "Current account problems are unavailable in this shell.", "error");
      renderState(repositoryOptions, "Current account git repositories are unavailable in this shell.", "error");
      referenceStatus.value = "This shell does not provide required identity access.";
      referenceStatus.dataset.state = "error";
      previewButton.disabled = true;
      return;
    }
    const currentPubkey = pubkey ?? await identity.getPublicKey();
    if (load !== referenceLoad) return;
    if (!currentPubkey) {
      renderState(problemOptions, "Connect a Nostr account to load your problems.", "error");
      renderState(repositoryOptions, "Connect a Nostr account to load your git repositories.", "error");
      referenceStatus.value = "A connected account is required before publishing a rocket.";
      referenceStatus.dataset.state = "error";
      previewButton.disabled = true;
      return;
    }

    const [problemResponse, repositoryResponse, relayPlan] = await Promise.all([
      outbox.query({ kinds: [31971], "#A": [ROOT_PROBLEM_COORDINATE] }, { timeoutMs: 8000 }),
      outbox.query({ kinds: [30617], authors: [currentPubkey] }, { authors: [currentPubkey], timeoutMs: 8000 }),
      outbox.resolveRelays({ pubkey: currentPubkey, direction: "read" }).catch((error: unknown) => {
        console.warn("Rocket reference relay fallback could not be resolved", { pubkey: currentPubkey, error });
        return { relays: [] as string[], source: "fallback" as const };
      })
    ]);
    if (load !== referenceLoad) return;
    if (relayPlan?.relays?.length) {
      for (const relay of relayPlan.relays) observedRelays.add(relay);
    }
    if (problemResponse.error && !problemResponse.events.length) throw new Error(problemResponse.error);
    if (repositoryResponse.error && !repositoryResponse.events.length) throw new Error(repositoryResponse.error);

    const problems = problemChoices(problemResponse.events as ChoiceResult[]);
    const repositories = repositoryChoices(repositoryResponse.events as ChoiceResult[], currentPubkey, relayPlan.relays);
    problems.length ? renderChoices(problemOptions, "problem", problems) : renderState(problemOptions, "No problems found in the NOSTROCKET tree.", "empty");
    repositories.length ? renderChoices(repositoryOptions, "repository", repositories) : renderState(repositoryOptions, "have you logged any git repositories?", "empty");
    const incomplete = problemResponse.incomplete || problemResponse.error || repositoryResponse.incomplete || repositoryResponse.error;
    referenceStatus.dataset.state = incomplete ? "warning" : "idle";
    referenceStatus.value = incomplete ? "Some relays did not respond. Available choices may be incomplete." : `${problems.length} problem${problems.length === 1 ? "" : "s"} and ${repositories.length} git repositor${repositories.length === 1 ? "y" : "ies"} available.`;
    previewButton.disabled = false;
  } catch (error) {
    if (load !== referenceLoad) return;
    console.error("Rocket problem and repository choices could not be loaded", { error });
    renderState(problemOptions, "Problems could not be loaded.", "error");
    renderState(repositoryOptions, "Git repositories could not be loaded.", "error");
    referenceStatus.dataset.state = "warning";
    referenceStatus.value = "Optional references could not be loaded. Check your relay connection to retry, or continue without them.";
    retryReferences.hidden = false;
    previewButton.disabled = false;
  }
}

retryReferences.addEventListener("click", () => void loadReferences());
const identitySubscription = typeof window.napplet?.identity?.onChanged === "function"
  ? identity.onChanged((pubkey) => void loadReferences(pubkey))
  : undefined;
if (identitySubscription) addEventListener("pagehide", () => identitySubscription.close(), { once: true });
void loadReferences();

try {
  const rocketSubscription = outbox.subscribe({ kinds: [31108] }, { timeoutMs: 8000 });
  rocketSubscription.on("event", (result) => {
    const identifier = rocketIdentifier(result.event);
    if (!identifier) return;
    observedIdentifiers.add(normalizeRocketIdentifier(identifier));
    syncIdentifierValidation();
  });
  rocketSubscription.on("closed", (reason) => {
    identifierStreamActive = false;
    console.warn("Rocket identifier subscription closed", { reason, observedIdentifierCount: observedIdentifiers.size });
    syncIdentifierValidation();
  });
  addEventListener("pagehide", () => rocketSubscription.close(), { once: true });
} catch (error) {
  identifierStreamActive = false;
  console.error("Rocket identifier subscription could not start", { error });
  syncIdentifierValidation();
}

function applyTheme(theme?: { colors: { background: string; text: string; primary: string } }): void {
  if (!theme) return;
  const valid = /^#[0-9a-f]{6}$/i;
  const { background, text, primary } = theme.colors;
  if (![background, text, primary].every((color) => valid.test(color))) { console.warn("Shell theme rejected because colors are not six-digit hex values", { background, text, primary }); return; }
  const root = document.documentElement;
  root.style.setProperty("--background", background); root.style.setProperty("--text", text); root.style.setProperty("--primary", primary);
  root.style.setProperty("--surface", `color-mix(in srgb, ${text} 4%, ${background})`); root.style.setProperty("--line", `color-mix(in srgb, ${text} 20%, ${background})`); root.style.setProperty("--muted", `color-mix(in srgb, ${text} 62%, ${background})`);
  root.style.backgroundColor = background; document.body.style.backgroundColor = background; document.body.style.color = text; app.style.backgroundColor = background;
}
if (typeof window.napplet?.theme?.get === "function") { themeGet().then(applyTheme).catch((error: unknown) => console.warn("Initial shell theme could not be read", { error })); themeOnChanged(applyTheme); }
if (!reducedMotion) gsap.fromTo(".masthead, #editor", { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: .42, stagger: .08, ease: "power3.out" });
