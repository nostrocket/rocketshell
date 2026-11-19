import { inc, outbox, resource, themeGet, themeOnChanged, type RelayEventResult } from "@napplet/sdk";
import { gsap } from "gsap";
import "./styles.css";
import { meritSlices } from "./distribution";
import { ROCKET_VIEW_CONVENTION, parseRocketViewPayload } from "./intent";
import { firstMatchingState } from "./load";
import { pendingMeritRequests, type PendingMeritRequest } from "./pending";
import { avatarHue, avatarLabel, holderProfilesFromEvents, type HolderProfile } from "./profiles";
import { selectNip66Relays } from "./relays";
import { NOSTROCKET_COORDINATE, rocketsFromEvents, type RocketOption } from "./rockets";
import { aggregateMeritHoldings, firstTag, validateStateEvent, type MeritHolding, type NostrEvent } from "./state";

declare global { interface Window { napplet?: { theme?: { get?: unknown }; resource?: unknown } } }
const app = (() => {
  const element = document.querySelector<HTMLElement>("#app");
  if (!element) throw new Error("Application root is missing.");
  return element;
})();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const number = new Intl.NumberFormat("en-US");
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-8)}`;
const escapeHtml = (value: string) => value.replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]!);
/** Relays that actually carry rocket state, used as hints rather than trusted routes. */
const RELAY_HINTS = ["wss://nos.lol", "wss://relay.routstr.com", "wss://relay.redsh1ft.com"];
let profiles = new Map<string, HolderProfile>();
let avatarUrls = new Map<string, string>();
let loadVersion = 0;
let rockets: RocketOption[] = [];
let selectedCoordinate = NOSTROCKET_COORDINATE;
let pendingRequests: PendingMeritRequest[] = [];
let pendingError: string | undefined;
/** Relays resolved by the last load, reused when an intent opens another rocket. */
let currentRelays: string[] = [];
/** A rocket requested through NAP-INTENT before discovery finished. */
let requestedCoordinate: string | undefined;
let initialLoadComplete = false;
let intentSubscription: { close(): void } | undefined;

function clearAvatars(): void {
  for (const url of avatarUrls.values()) URL.revokeObjectURL(url);
  avatarUrls = new Map();
}

const holderName = (owner: string): string => profiles.get(owner)?.name ?? short(owner);
const holderAvatar = (owner: string): string => {
  const name = profiles.get(owner)?.name;
  const url = avatarUrls.get(owner);
  return `<span class="holder-avatar" style="--avatar-hue:${avatarHue(owner)}">
    <span class="avatar-fallback" aria-hidden="true">${escapeHtml(avatarLabel(name, owner))}</span>
    ${url ? `<img src="${escapeHtml(url)}" data-avatar-owner="${owner}" alt="">` : ""}
  </span>`;
};

function applyTheme(theme?: { colors: { background: string; text: string; primary: string } }): void {
  if (!theme) return;
  const valid = /^#[0-9a-f]{6}$/i;
  const { background, text, primary } = theme.colors;
  if (![background, text, primary].every((color) => valid.test(color))) {
    console.warn("Shell theme rejected because colors are not six-digit hex values", { background, text, primary });
    return;
  }
  const root = document.documentElement;
  root.style.setProperty("--background", background);
  root.style.setProperty("--text", text);
  root.style.setProperty("--primary", primary);
  root.style.setProperty("--surface", `color-mix(in srgb, ${text} 5%, ${background})`);
  root.style.setProperty("--line", `color-mix(in srgb, ${text} 18%, ${background})`);
  root.style.setProperty("--muted", `color-mix(in srgb, ${text} 62%, ${background})`);
}

function renderState(event: NostrEvent, relays: string[], animate = true): void {
  const selectedRocket = rockets.find(({ coordinate }) => coordinate === selectedCoordinate) ?? { coordinate: selectedCoordinate, name: firstTag(event, "d") ?? "Rocket", author: event.pubkey };
  const holdings = aggregateMeritHoldings(event);
  const slices = meritSlices(holdings);
  const total = holdings.reduce((sum, holding) => sum + holding.merits, 0n);
  const meritLots = holdings.reduce((sum, holding) => sum + holding.lots.length, 0);
  const bitcoin = firstTag(event, "bitcoin")?.split(":") ?? [];
  app.innerHTML = `<article class="state-view">
    <header class="masthead"><div><span class="eyebrow">Microsubjective Blockchain</span><h1>${escapeHtml(selectedRocket.name)}</h1><p>${escapeHtml(firstTag(event, "mission") ?? "Mission unavailable")}</p></div><button id="refresh" type="button">Refresh state</button></header>
    <div class="rocket-picker"><label for="rocket-select">View rocket</label><div><select id="rocket-select">${rockets.map((rocket) => `<option value="${escapeHtml(rocket.coordinate)}"${rocket.coordinate === selectedCoordinate ? " selected" : ""}>${escapeHtml(rocket.name)}</option>`).join("")}</select><span>${rockets.length} discovered via kind 31108</span></div></div>
    <section class="summary" aria-label="State summary"><div><span>Total merit</span><strong>${number.format(total)}</strong></div><div><span>Holders</span><strong>${holdings.length}</strong></div><div><span>Merit lots</span><strong>${meritLots}</strong></div></section>
    <div class="ownership-layout">
      <figure class="distribution" aria-labelledby="distribution-title" aria-describedby="distribution-description">
        <h2 id="distribution-title">Merit distribution</h2>
        <svg viewBox="0 0 100 100" role="img">${slices.map((slice) => `<path d="${slice.path}" fill="${slice.color}"><title>${escapeHtml(holderName(slice.owner))}: ${slice.percent.toFixed(2)}%</title></path>`).join("")}</svg>
        <figcaption id="distribution-description">Slice colors match holder rows. Percentages use current merit totals.</figcaption>
      </figure>
      <section class="holdings" aria-labelledby="holdings-title"><header><div><h2 id="holdings-title">Merit holders</h2></div><span>${holdings.length} current holders</span></header>
        <ol>${holdings.map((holding, index) => { const slice = slices[index]; const percent = slice?.percent ?? 0; const name = holderName(holding.owner); return `<li class="holding" style="--slice:${slice?.color ?? "var(--primary)"}"><details><summary><span class="rank"><i></i>${String(index + 1).padStart(2, "0")}</span><span class="identity">${holderAvatar(holding.owner)}<span class="owner"><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong><small title="${holding.owner}">${short(holding.owner)} · ${holding.lots.length} lot${holding.lots.length === 1 ? "" : "s"}</small></span></span><span class="share"><strong>${number.format(holding.merits)}</strong><small>${percent.toFixed(2)}%</small></span><span class="bar" style="--share:${percent}%"><i></i></span></summary><div class="lots"><header><span>Approved request</span><span>Merit</span></header>${holding.lots.map((lot) => `<div><code title="${lot.requestId}">${short(lot.requestId)}</code><strong>${number.format(lot.merits)}</strong></div>`).join("")}</div></details></li>`; }).join("")}</ol>
      </section>
    </div>
    <section class="pending" aria-labelledby="pending-title"><header><div><h2 id="pending-title">Pending merit requests</h2><p>Requests not yet represented by a merit lot in this state.</p></div><strong>${pendingRequests.length}</strong></header>
      ${pendingError ? `<p class="pending-error" role="status">${escapeHtml(pendingError)}</p>` : pendingRequests.length ? `<ol>${pendingRequests.map((request) => `<li><span class="identity">${holderAvatar(request.requester)}<span class="owner"><strong>${escapeHtml(holderName(request.requester))}</strong><small title="${request.requester}">${short(request.requester)} · ${new Date(request.createdAt * 1000).toLocaleDateString()}</small></span></span><span class="pending-problem">${escapeHtml(request.problem)}</span><span class="share"><strong>${number.format(request.merits)}</strong><small>requested merit</small></span></li>`).join("")}</ol>` : `<p class="empty-pending">No pending merit requests found for this rocket.</p>`}
    </section>
    <footer class="provenance"><div><span>State event</span><code title="${event.id}">${short(event.id)}</code></div><div><span>Published</span><time datetime="${new Date(event.created_at * 1000).toISOString()}">${new Date(event.created_at * 1000).toLocaleString()}</time></div><div><span>Ruleset</span><code>${escapeHtml(firstTag(event, "ruleset") ?? "unknown")}</code></div><div><span>Bitcoin height</span><code>${escapeHtml(bitcoin[0] ?? "unknown")}</code></div><div class="relay-line"><span>First response search</span><code>${escapeHtml(relays.length ? relays.join(" · ") : "author outbox routing")}</code></div></footer>
    <output id="status" aria-live="polite"></output>
  </article>`;
  document.querySelector<HTMLButtonElement>("#refresh")?.addEventListener("click", () => void load());
  document.querySelector<HTMLSelectElement>("#rocket-select")?.addEventListener("change", (event) => {
    const coordinate = (event.currentTarget as HTMLSelectElement).value;
    void activateRocket(coordinate, relays);
  });
  document.querySelectorAll<HTMLImageElement>("[data-avatar-owner]").forEach((image) => image.addEventListener("error", () => {
    console.warn("Holder avatar could not be decoded; using generated fallback", { owner: image.dataset.avatarOwner });
    image.remove();
  }, { once: true }));
  if (animate && !reducedMotion) {
    gsap.fromTo(".rocket-picker, .summary > div, .distribution, .holding, .pending, .provenance > div", { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: .45, stagger: .035, ease: "power3.out" });
    gsap.fromTo(".distribution path", { scale: .86, transformOrigin: "50% 50%" }, { scale: 1, duration: .55, stagger: .035, ease: "expo.out" });
  }
}

async function loadProfiles(holdings: MeritHolding[], event: NostrEvent, relays: string[], version: number): Promise<void> {
  const authors = [...new Set([...holdings.map(({ owner }) => owner), ...pendingRequests.map(({ requester }) => requester)])];
  const status = document.querySelector<HTMLOutputElement>("#status");
  if (!authors.length) return;
  if (status) status.textContent = "Loading names and avatars…";
  try {
    const response = await outbox.query([{ kinds: [0], authors, limit: authors.length }], { authors, limit: authors.length, timeoutMs: 8000 });
    if (version !== loadVersion) return;
    profiles = holderProfilesFromEvents(authors, response.events.map(({ event: metadata }) => metadata as NostrEvent));
    const pictures = [...profiles.entries()].filter((entry): entry is [string, HolderProfile & { picture: string }] => Boolean(entry[1].picture));
    if (pictures.length && !window.napplet?.resource) {
      console.warn("Holder profile pictures unavailable; shell resource domain is missing", { holders: pictures.length });
    } else {
      const loaded = await Promise.all(pictures.map(async ([owner, profile]) => {
        try {
          const blob = await resource.bytes(profile.picture);
          if (!blob.type.startsWith("image/")) {
            console.warn("Holder profile picture rejected; resource is not an image", { owner, picture: profile.picture, mimeType: blob.type });
            return undefined;
          }
          return [owner, URL.createObjectURL(blob)] as const;
        } catch (error) {
          console.warn("Holder profile picture fetch failed; using generated avatar", { owner, picture: profile.picture, error });
          return undefined;
        }
      }));
      if (version !== loadVersion) {
        loaded.forEach((entry) => { if (entry) URL.revokeObjectURL(entry[1]); });
        return;
      }
      avatarUrls = new Map(loaded.filter((entry): entry is readonly [string, string] => Boolean(entry)));
    }
    renderState(event, relays, false);
    const updatedStatus = document.querySelector<HTMLOutputElement>("#status");
    if (updatedStatus) updatedStatus.textContent = profiles.size ? "Profiles loaded." : "No profiles found; showing pubkeys.";
  } catch (error) {
    console.warn("Holder profile metadata query failed; using pubkey fallbacks", { authors, error });
    if (status && version === loadVersion) status.textContent = "Holder profiles unavailable; showing pubkeys.";
  }
}

async function activateRocket(coordinate: string, relays: string[]): Promise<void> {
  const version = ++loadVersion;
  selectedCoordinate = coordinate;
  pendingRequests = [];
  pendingError = undefined;
  profiles = new Map();
  clearAvatars();
  const selected = rockets.find((rocket) => rocket.coordinate === coordinate);
  try {
    const stateRelays = [...new Set([...relays, ...RELAY_HINTS])];
    const event = selected?.event ?? await firstMatchingState(outbox.subscribe as Parameters<typeof firstMatchingState>[0], coordinate, stateRelays);
    if (version !== loadVersion) return;
    validateStateEvent(event, coordinate);
    if (selected) selected.event = event;
    // An intent can name a rocket discovery has not seen yet; add it so the
    // picker keeps showing the rocket whose state is on screen.
    else rockets = [{ coordinate, name: firstTag(event, "d") ?? "Rocket", author: event.pubkey, event }, ...rockets];
    renderState(event, relays);
    try {
      const response = await outbox.query([{ kinds: [1409], "#a": [coordinate], limit: 500 }], { limit: 500, timeoutMs: 8000 });
      if (version !== loadVersion) return;
      pendingRequests = pendingMeritRequests(response.events.map(({ event: request }) => request as NostrEvent), event, coordinate);
      renderState(event, relays, false);
    } catch (error) {
      console.warn("Pending merit request query failed", { coordinate, error });
      pendingError = "Pending merit requests could not be loaded for this rocket.";
      renderState(event, relays, false);
    }
    await loadProfiles(aggregateMeritHoldings(event), event, relays, version);
  } catch (error) {
    if (version === loadVersion) showError(error);
  }
}

function showError(error: unknown): void {
  const rocketName = rockets.find(({ coordinate }) => coordinate === selectedCoordinate)?.name ?? "rocket";
  console.error("Rocket state load failed", { coordinate: selectedCoordinate, error });
  app.innerHTML = `<section class="error-state" role="alert"><span class="eyebrow">State unavailable</span><h1>Could not read ${escapeHtml(rocketName)}.</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p><button id="retry" type="button">Try again</button></section>`;
  document.querySelector<HTMLButtonElement>("#retry")?.addEventListener("click", () => void load());
}

async function load(): Promise<void> {
  const version = ++loadVersion;
  clearAvatars();
  profiles = new Map();
  pendingRequests = [];
  pendingError = undefined;
  app.innerHTML = `<section class="boot-state" aria-live="polite"><div class="pulse"></div><p>Finding healthy relays, then reading first state…</p></section>`;
  try {
    const discovery = await outbox.query([{ kinds: [30166], limit: 500 }], { limit: 500, timeoutMs: 4500 });
    const relays = selectNip66Relays(discovery.events.map((result: RelayEventResult) => result.event as NostrEvent)).map(({ url }) => url);
    if (!relays.length) console.warn("No suitable NIP-66 observations found; using shell author-outbox routing");
    currentRelays = relays;
    try {
      const response = await outbox.query([{ kinds: [31108], limit: 500 }], { limit: 500, timeoutMs: 8000, relays: RELAY_HINTS });
      rockets = rocketsFromEvents(response.events.map(({ event }) => event as NostrEvent));
    } catch (error) {
      console.warn("Rocket discovery query failed; loading NOSTROCKET directly", { error });
      rockets = rocketsFromEvents([]);
    }
    if (version !== loadVersion) return;
    // An intent that arrived while discovery was running wins over the default.
    const preferred = requestedCoordinate ?? selectedCoordinate;
    const preferredRocket = rockets.find(({ coordinate }) => coordinate === preferred);
    if (preferredRocket) {
      selectedCoordinate = preferred;
    } else {
      const firstWithEvent = rockets.find(({ event }) => event);
      if (!firstWithEvent) {
        showError(new Error(`No rockets were discovered; nothing to show for ${preferred}.`));
        return;
      }
      selectedCoordinate = firstWithEvent.coordinate;
      if (requestedCoordinate) {
        console.warn("Requested rocket was not discovered; opening the first discovered rocket instead", { requested: requestedCoordinate, opening: selectedCoordinate });
      }
    }
    await activateRocket(selectedCoordinate, relays);
  } catch (error) { if (version === loadVersion) showError(error); }
  finally { initialLoadComplete = true; }
}

/**
 * NAP-INTENT entry point: open the ledger for the rocket named by a
 * `napplet:rocket/open` dispatch. Before discovery finishes the request is
 * remembered and `load()` honors it; afterwards it activates directly.
 */
function handleRocketViewIntent(payload: unknown): void {
  const parsed = parseRocketViewPayload(payload);
  if (!parsed) {
    console.warn("Rocket view intent ignored; payload did not name a valid rocket", { convention: ROCKET_VIEW_CONVENTION });
    return;
  }
  requestedCoordinate = parsed.coordinate;
  if (!initialLoadComplete) return;
  void activateRocket(parsed.coordinate, currentRelays);
}

function startIntentListener(): void {
  try {
    intentSubscription = inc.on(ROCKET_VIEW_CONVENTION, (event) => handleRocketViewIntent(event.payload));
  } catch (error) {
    console.warn("Rocket view intent subscription failed; the picker still works", { convention: ROCKET_VIEW_CONVENTION, error });
  }
}

if (typeof window.napplet?.theme?.get === "function") {
  themeGet().then(applyTheme).catch((error: unknown) => console.warn("Initial shell theme could not be read", { error }));
  themeOnChanged(applyTheme);
}
window.addEventListener("pagehide", () => { clearAvatars(); intentSubscription?.close(); }, { once: true });
startIntentListener();
void load();
