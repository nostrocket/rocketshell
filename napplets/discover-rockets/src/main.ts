import { outbox, resource, themeGet, themeOnChanged } from "@napplet/sdk";
import { gsap } from "gsap";
import "./styles.css";
import { filterForest, forestFromRockets, forestStats, rocketsFromEvents, type NostrEvent, type RocketNode } from "./rockets";

declare global { interface Window { napplet?: { theme?: { get?: unknown }; resource?: unknown } } }

const app = (() => {
  const element = document.querySelector<HTMLElement>("#app");
  if (!element) throw new Error("Application root is missing.");
  return element;
})();

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-8)}`;
const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]!);

type AuthorProfile = { name?: string; picture?: string };

const eventsById = new Map<string, NostrEvent>();
let forest: RocketNode[] = [];
let profiles = new Map<string, AuthorProfile>();
let avatarUrls = new Map<string, string>();
let filterText = "";
const collapsed = new Set<string>();
let loadVersion = 0;
let liveRetries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function clearAvatars(): void {
  for (const url of avatarUrls.values()) URL.revokeObjectURL(url);
  avatarUrls = new Map();
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function profilesFromEvents(authors: string[], events: NostrEvent[]): Map<string, AuthorProfile> {
  const wanted = new Set(authors);
  const latest = new Map<string, NostrEvent>();
  for (const event of events) {
    if (event.kind !== 0 || !wanted.has(event.pubkey)) continue;
    const current = latest.get(event.pubkey);
    if (!current || event.created_at > current.created_at || (event.created_at === current.created_at && event.id < current.id)) latest.set(event.pubkey, event);
  }
  const found = new Map<string, AuthorProfile>();
  for (const [author, event] of latest) {
    try {
      const content = JSON.parse(event.content) as Record<string, unknown>;
      const name = nonEmptyString(content.display_name) ?? nonEmptyString(content.name) ?? nonEmptyString(content.nip05);
      const picture = nonEmptyString(content.picture);
      if (name || picture) found.set(author, { name, picture });
    } catch (error) {
      console.warn("Ignoring malformed author profile metadata", { author, eventId: event.id, error });
    }
  }
  return found;
}

function avatarHue(pubkey: string): number {
  return Array.from(pubkey).reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) % 360, 0);
}

function avatarChip(identifier: string, author: string): string {
  const name = profiles.get(author)?.name;
  const url = avatarUrls.get(author);
  const words = (name ?? identifier).trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const label = (words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0]?.slice(0, 2) ?? author.slice(0, 2)).toUpperCase().padEnd(2, "?");
  return `<span class="avatar" style="--avatar-hue:${avatarHue(author)}" title="${escapeHtml(author)}">
    <span class="avatar-fallback" aria-hidden="true">${escapeHtml(label)}</span>
    ${url ? `<img src="${escapeHtml(url)}" data-avatar-author="${author}" alt="">` : ""}
  </span>`;
}

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

function rebuildForest(): void {
  forest = forestFromRockets(rocketsFromEvents([...eventsById.values()]));
}

function renderChrome(): void {
  app.innerHTML = `<article class="discover-view">
    <header class="masthead">
      <div><span class="eyebrow">Nostrocket MSB · ruleset 334000</span><h1>Discover Rockets</h1><p>Every Sovereign Economic Community ignition found via kind 31108, arranged as a multi-root hierarchy.</p></div>
      <button id="refresh" type="button">Refresh</button>
    </header>
    <div class="toolbar">
      <label class="search"><span>Filter rockets</span><input id="rocket-filter" type="search" placeholder="Identifier or mission…" autocomplete="off" value="${escapeHtml(filterText)}"></label>
      <p class="stats" id="stats"></p>
      <p class="live" id="live-indicator" title="Live kind 31108 subscription state"><i></i><span>connecting</span></p>
    </div>
    <div id="forest" class="forest"></div>
    <output id="status" aria-live="polite"></output>
  </article>`;
  document.querySelector<HTMLButtonElement>("#refresh")?.addEventListener("click", () => void load());
  document.querySelector<HTMLInputElement>("#rocket-filter")?.addEventListener("input", (event) => {
    filterText = (event.currentTarget as HTMLInputElement).value;
    renderForest({ animate: false });
  });
}

let liveDotTween: gsap.core.Tween | undefined;

function pulseLiveDot(): void {
  liveDotTween?.kill();
  const dot = document.querySelector<HTMLElement>("#live-indicator i");
  if (!dot || reducedMotion) return;
  liveDotTween = gsap.to(dot, { opacity: .35, duration: .9, repeat: -1, yoyo: true, ease: "sine.inOut" });
}

function setLive(state: string): void {
  const indicator = document.querySelector<HTMLElement>("#live-indicator");
  if (!indicator) return;
  indicator.dataset.state = state === "live" ? "live" : state === "off" ? "off" : "connecting";
  indicator.querySelector("span")!.textContent = state;
  if (state !== "live") { liveDotTween?.kill(); liveDotTween = undefined; if (state === "off") gsap.set(indicator.querySelector("i"), { opacity: 1 }); }
}

function nodeHtml(node: RocketNode, ids: { n: number }): string {
  const { rocket } = node;
  const forcedOpen = filterText.trim().length > 0;
  const expanded = forcedOpen || !collapsed.has(rocket.coordinate);
  const branchId = `branch-${ids.n++}`;
  const hasChildren = node.children.length > 0;
  const heading = node.depth === 0 ? "h2" : "h3";
  const badges: string[] = [];
  if (node.depth === 0) {
    badges.push(rocket.parent === "this"
      ? `<span class="badge badge-root">root</span>`
      : `<span class="badge badge-detached" title="Parent ${escapeHtml(rocket.parent)} not among discovered rockets">detached parent</span>`);
  }
  if (rocket.problem) badges.push(`<span class="badge" title="${escapeHtml(rocket.problem.coordinate)}">problem ${escapeHtml(short(rocket.problem.coordinate))}</span>`);
  if (rocket.repo) badges.push(`<span class="badge" title="${escapeHtml(rocket.repo.coordinate)}">repo ${escapeHtml(short(rocket.repo.coordinate))}</span>`);
  if (hasChildren) badges.push(`<span class="badge badge-count">${node.children.length} sub-rocket${node.children.length === 1 ? "" : "s"}</span>`);
  return `<section class="rocket${node.depth === 0 ? " rocket-root" : ""}" data-coordinate="${escapeHtml(rocket.coordinate)}" style="--depth:${node.depth}">
    <header class="rocket-head">
      ${hasChildren
        ? `<button class="toggle" type="button" data-toggle="${escapeHtml(rocket.coordinate)}" aria-expanded="${expanded}" aria-controls="${branchId}"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l5 4-5 4"/></svg><span class="sr-only">${expanded ? "Collapse" : "Expand"} ${escapeHtml(rocket.identifier)}</span></button>`
        : `<span class="toggle-spacer" aria-hidden="true"></span>`}
      ${avatarChip(rocket.identifier, rocket.author)}
      <div class="rocket-id"><${heading} class="rocket-name">${escapeHtml(rocket.identifier)}</${heading}>
        ${rocket.mission ? `<p class="rocket-mission">${escapeHtml(rocket.mission)}</p>` : ""}
      </div>
      <div class="rocket-meta">${badges.join("")}</div>
    </header>
    <footer class="rocket-foot">
      <span class="author" title="${rocket.author}">${escapeHtml(profiles.get(rocket.author)?.name ?? short(rocket.author))}</span>
      <time datetime="${new Date(rocket.createdAt * 1000).toISOString()}">${new Date(rocket.createdAt * 1000).toLocaleDateString()}</time>
      <code title="${escapeHtml(rocket.event.id)}">${escapeHtml(short(rocket.event.id))}</code>
    </footer>
    ${hasChildren ? `<div class="rocket-children" id="${branchId}"${expanded ? "" : " hidden"}>${node.children.map((child) => nodeHtml(child, ids)).join("")}</div>` : ""}
  </section>`;
}

function expandChildren(container: HTMLElement): void {
  container.hidden = false;
  if (reducedMotion) return;
  gsap.fromTo(container, { height: 0, opacity: 0 }, { height: "auto", opacity: 1, duration: .3, ease: "power2.out", clearProps: "height,opacity" });
}

function collapseChildren(container: HTMLElement): void {
  if (reducedMotion) { container.hidden = true; return; }
  gsap.to(container, { height: 0, opacity: 0, duration: .25, ease: "power2.in", onComplete: () => {
    container.hidden = true;
    gsap.set(container, { clearProps: "all" });
  } });
}

function bindInteractions(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((button) => button.addEventListener("click", () => {
    const coordinate = button.dataset.toggle!;
    const target = document.getElementById(button.getAttribute("aria-controls")!);
    if (!target) return;
    if (button.getAttribute("aria-expanded") === "true") {
      collapsed.add(coordinate);
      button.setAttribute("aria-expanded", "false");
      collapseChildren(target);
    } else {
      collapsed.delete(coordinate);
      button.setAttribute("aria-expanded", "true");
      expandChildren(target);
    }
  }));
  container.querySelectorAll<HTMLImageElement>("[data-avatar-author]").forEach((image) => image.addEventListener("error", () => {
    console.warn("Author avatar could not be decoded; using generated fallback", { author: image.dataset.avatarAuthor });
    image.remove();
  }, { once: true }));
}

function renderForest(options: { animate?: boolean; highlight?: string } = {}): void {
  const container = document.querySelector<HTMLElement>("#forest");
  if (!container) return;
  const visible = filterForest(forest, filterText);
  const stats = forestStats(visible);
  const statsElement = document.querySelector<HTMLElement>("#stats");
  if (statsElement) {
    statsElement.textContent = stats.rockets
      ? `${stats.roots} root${stats.roots === 1 ? "" : "s"} · ${stats.rockets} rocket${stats.rockets === 1 ? "" : "s"} · ${stats.maxDepth + 1} level${stats.maxDepth === 0 ? "" : "s"}`
      : "No rockets discovered";
  }
  container.innerHTML = stats.rockets
    ? visible.map((node) => nodeHtml(node, { n: 0 })).join("")
    : `<p class="empty-forest">${filterText.trim() ? "No rockets match this filter." : "No rockets discovered yet."}</p>`;
  bindInteractions(container);
  if (!reducedMotion && (options.animate || options.highlight)) {
    if (options.animate) {
      gsap.fromTo(container.querySelectorAll(".rocket-root > .rocket-head, .rocket-root > .rocket-foot, .rocket-root > .rocket-children"),
        { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: .45, stagger: .04, ease: "power3.out" });
    }
    if (options.highlight) {
      const card = container.querySelector<HTMLElement>(`[data-coordinate="${CSS.escape(options.highlight)}"]`);
      if (card) {
        gsap.fromTo(card, { boxShadow: "0 0 0 3px var(--primary)" }, { boxShadow: "0 0 0 3px rgba(0,0,0,0)", duration: 1.4, ease: "power2.out", clearProps: "boxShadow" });
      }
    }
  }
}

function liveEventHandlers(version: number): { onEvent: (event: NostrEvent) => void; onClosed: (reason: string) => void } {
  return {
    onEvent(event) {
      if (eventsById.has(event.id)) return;
      eventsById.set(event.id, event);
      rebuildForest();
      renderForest({ highlight: parseCoordinate(event) });
      void loadProfiles(version);
    },
    onClosed(reason) {
      setLive("off");
      if (version !== loadVersion) return;
      if (liveRetries >= 5) {
        const status = document.querySelector<HTMLOutputElement>("#status");
        if (status) status.textContent = `Live subscription closed; refresh to resume. ${reason}`.trim();
        return;
      }
      liveRetries += 1;
      retryTimer = setTimeout(() => { if (version === loadVersion) subscribeLive(version); }, 15000);
    }
  };
}

function parseCoordinate(event: NostrEvent): string | undefined {
  if (event.kind !== 31108) return undefined;
  const identifier = event.tags.find(([name]) => name === "d")?.[1]?.trim();
  return identifier ? `31108:${event.pubkey}:${identifier}` : undefined;
}

function subscribeLive(version: number): void {
  setLive("connecting");
  try {
    const subscription = outbox.subscribe([{ kinds: [31108] }], { timeoutMs: 8000 });
    const handlers = liveEventHandlers(version);
    subscription.on("event", (result) => handlers.onEvent(result.event as NostrEvent));
    subscription.on("closed", (reason) => handlers.onClosed(typeof reason === "string" ? reason : "closed by shell"));
    setLive("live");
    pulseLiveDot();
  } catch (error) {
    console.warn("Live rocket subscription failed", { error });
    liveEventHandlers(version).onClosed(error instanceof Error ? error.message : "subscription failed");
  }
}

async function loadProfiles(version: number): Promise<void> {
  const authors = [...new Set(collectAuthors(forest))];
  if (!authors.length) return;
  const status = document.querySelector<HTMLOutputElement>("#status");
  try {
    const response = await outbox.query([{ kinds: [0], authors, limit: authors.length }], { authors, limit: authors.length, timeoutMs: 8000 });
    if (version !== loadVersion) return;
    profiles = profilesFromEvents(authors, response.events.map(({ event }) => event as NostrEvent));
    const pictures = [...profiles.entries()].filter((entry): entry is [string, AuthorProfile & { picture: string }] => Boolean(entry[1].picture));
    if (pictures.length && !window.napplet?.resource) {
      console.warn("Author profile pictures unavailable; shell resource domain is missing", { authors: pictures.length });
    } else {
      const loaded = await Promise.all(pictures.map(async ([author, profile]) => {
        try {
          const blob = await resource.bytes(profile.picture);
          if (!blob.type.startsWith("image/")) {
            console.warn("Author profile picture rejected; resource is not an image", { author, picture: profile.picture, mimeType: blob.type });
            return undefined;
          }
          return [author, URL.createObjectURL(blob)] as const;
        } catch (error) {
          console.warn("Author profile picture fetch failed; using generated avatar", { author, picture: profile.picture, error });
          return undefined;
        }
      }));
      if (version !== loadVersion) {
        loaded.forEach((entry) => { if (entry) URL.revokeObjectURL(entry[1]); });
        return;
      }
      clearAvatars();
      avatarUrls = new Map(loaded.filter((entry): entry is readonly [string, string] => Boolean(entry)));
    }
    renderForest({ animate: false });
    const updatedStatus = document.querySelector<HTMLOutputElement>("#status");
    if (updatedStatus) updatedStatus.textContent = profiles.size ? "Author profiles loaded." : "No author profiles found; showing pubkeys.";
  } catch (error) {
    console.warn("Author profile query failed; using pubkey fallbacks", { authors, error });
    if (status && version === loadVersion) status.textContent = "Author profiles unavailable; showing pubkeys.";
  }
}

function collectAuthors(roots: readonly RocketNode[]): string[] {
  const authors: string[] = [];
  const walk = (node: RocketNode): void => {
    authors.push(node.rocket.author);
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return authors;
}

function showError(error: unknown): void {
  console.error("Rocket discovery failed", { error });
  app.innerHTML = `<section class="error-state" role="alert"><span class="eyebrow">Discovery unavailable</span><h1>Could not read rocket ignitions.</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p><button id="retry" type="button">Try again</button></section>`;
  document.querySelector<HTMLButtonElement>("#retry")?.addEventListener("click", () => void load());
}

async function load(): Promise<void> {
  const version = ++loadVersion;
  liveRetries = 0;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
  clearAvatars();
  profiles = new Map();
  eventsById.clear();
  app.innerHTML = `<section class="boot-state" aria-live="polite"><div class="pulse"></div><p>Querying kind 31108 ignitions through the author outbox…</p></section>`;
  if (!reducedMotion) gsap.fromTo(".pulse", { scaleX: .2, opacity: .35 }, { scaleX: 1, opacity: 1, duration: .8, repeat: -1, yoyo: true, ease: "sine.inOut", transformOrigin: "0 50%" });
  try {
    const response = await outbox.query([{ kinds: [31108], limit: 500 }], { limit: 500, timeoutMs: 8000 });
    if (version !== loadVersion) return;
    for (const { event } of response.events) eventsById.set(event.id, event as NostrEvent);
    if (response.error) console.warn("Rocket discovery query returned partial results", { error: response.error });
    rebuildForest();
    renderChrome();
    renderForest({ animate: true });
    const status = document.querySelector<HTMLOutputElement>("#status");
    if (status && response.incomplete) status.textContent = "Discovery results are partial; some relays did not respond.";
    subscribeLive(version);
    await loadProfiles(version);
  } catch (error) {
    if (version === loadVersion) showError(error);
  }
}

if (typeof window.napplet?.theme?.get === "function") {
  themeGet().then(applyTheme).catch((error: unknown) => console.warn("Initial shell theme could not be read", { error }));
  themeOnChanged(applyTheme);
}
window.addEventListener("pagehide", clearAvatars, { once: true });
void load();
