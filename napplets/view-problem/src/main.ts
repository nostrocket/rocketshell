/*
  DIRECTION: Focused civic issue record. White reading surface, electric-blue
  action rail, compact semantic state, and discussion as continuous ledger.
  FORM: User-pinned problem-detail composition extended from sibling tracker UI.
  FINISH: Operate mode; responsive sandbox controls, visible state, restrained motion.
*/
import { identity, inc, intent, outbox, resource, type OutboxSubscription, type RelayEventResult, type Subscription } from "@napplet/sdk";
import { gsap } from "gsap";
import "./styles.css";
import {
  COMMENT_KIND, buildWorkflowTemplate, compareProblemRevisions, coordinateFromProblemEvent, formatClaimCountdown, hasClaimRequest, hasProblemChildren, parseCoordinate,
  mayEditProblem, missingProblemAncestorCoordinates, problemEdits, problemResultsAtCoordinate, problemRevisionAuthors, problemRevisionHistory, resolveProblemAncestorOwnersIfComplete,
  selectEffectiveClaim, selectProblem, shortKey,
  type ProblemView
} from "./problem";
import { pubkeyAvatarHue, pubkeyAvatarLabel, pubkeyDisplay } from "./avatar";
import { profileFromEvents, type ProfileData } from "./profile";
import { formatRelativeTime } from "./time";
import { renderMarkdown } from "./markdown";
import { ingestUniqueResults } from "./incremental";
import { canRequestMerits, openAdjacentMeritRequest } from "./merit-request-intent";

const app = (() => {
  const element = document.querySelector<HTMLElement>("#app");
  if (!element) throw new Error("Application root is missing.");
  return element;
})();

let problem: ProblemView | undefined;
let comments: RelayEventResult[] = [];
let relatedEvents: RelayEventResult[] = [];
const resultsById = new Map<string, RelayEventResult>();
let ancestorOwners: string[] = [];
let pubkey = "";
let discussionSubscription: OutboxSubscription | undefined;
let loadGeneration = 0;
let identitySubscription: { close(): void } | undefined;
let intentSubscription: Subscription | undefined;
let busy = false;
let meritRequestBusy = false;
let liveMessage = "";
let intentReceived = false;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
const profiles = new Map<string, ProfileData>();
const avatarHandles = new Map<string, { url: string; revoke(): void }>();
const avatarRequestVersions = new Map<string, number>();
const profileLoadingAuthors = new Set<string>();
const avatarLoadingAuthors = new Set<string>();
const mediaObjectUrls = new Set<string>();
let mediaRenderVersion = 0;
let recordEntrancePending = true;
let profileShimmerTweens: gsap.core.Tween[] = [];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
type LoadTask = "problem" | "discussion" | "graph" | "ancestors" | "children";
type LoadState = "idle" | "loading" | "complete" | "failed";
const loadStates: Record<LoadTask, LoadState> = {
  problem: "idle", discussion: "idle", graph: "idle", ancestors: "idle", children: "idle"
};

function resetResults(): void {
  resultsById.clear();
  comments = [];
  relatedEvents = [];
  for (const task of Object.keys(loadStates) as LoadTask[]) loadStates[task] = "idle";
}

function backgroundStatus(): string {
  const loading = (Object.keys(loadStates) as LoadTask[]).filter((task) => loadStates[task] === "loading");
  const failed = (Object.keys(loadStates) as LoadTask[]).filter((task) => loadStates[task] === "failed");
  if (loading.length) return `Refreshing ${loading.join(", ")}…`;
  if (failed.length) return `Some background data unavailable (${failed.join(", ")}). Reopen to retry.`;
  return "";
}

function setLoadState(task: LoadTask, state: LoadState): void {
  loadStates[task] = state;
  if (problem) render();
}

function ingestResults(results: RelayEventResult[], coordinate: string): string[] {
  const added = ingestUniqueResults(resultsById, results);
  if (!added.length) return [];
  const authors = new Set(added.map(({ event }) => event.pubkey));
  comments = [...resultsById.values()].filter(({ event }) => event.kind === COMMENT_KIND);
  relatedEvents = [...resultsById.values()].filter(({ event }) => event.kind === 31971);
  try {
    problem = selectProblem(coordinate, relatedEvents);
    refreshAncestorOwners(coordinate);
  } catch (error) {
    console.warn("Incremental problem event set is not renderable yet", { coordinate, error });
  }
  if (problem) render();
  return [...authors];
}

function refreshAncestorOwners(coordinate: string): void {
  if (!problem) return;
  try {
    const resolved = resolveProblemAncestorOwnersIfComplete(problem, relatedEvents);
    ancestorOwners = resolved ?? [];
  } catch (error) {
    ancestorOwners = [];
    console.warn("Problem ancestor authorization could not be resolved", { coordinate, error });
  }
}

async function hydrateProblemAncestors(selected: ProblemView, generation: number): Promise<void> {
  const attempted = new Set<string>();
  while (true) {
    if (generation !== loadGeneration) return;
    const missing = missingProblemAncestorCoordinates(selected, relatedEvents)
      .filter((coordinate) => !attempted.has(coordinate));
    if (!missing.length) return;
    missing.forEach((coordinate) => attempted.add(coordinate));
    const responses = await Promise.all(missing.map(async (coordinate) => {
      const [, owner = "", problemId = ""] = coordinate.split(":");
      const response = await outbox.query(
        { kinds: [31971], "#d": [problemId], limit: 200 },
        { authors: [owner], limit: 200, timeoutMs: 8000 }
      );
      return problemResultsAtCoordinate(coordinate, response.events);
    }));
    if (generation !== loadGeneration) return;
    const authors = ingestResults(responses.flat(), selected.coordinate);
    void loadProfiles(authors);
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>\"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"
})[character]!);

function showSetup(message = "") {
  recordEntrancePending = true;
  resetMedia();
  stopDiscussionSubscription();
  if (countdownTimer) clearInterval(countdownTimer);
  app.innerHTML = `<section class="setup" aria-labelledby="setup-title">
    <div class="setup-glyph" aria-hidden="true"><span></span><span></span><span></span></div>
    <div><h1 id="setup-title">Open a problem</h1><p>Paste its full NIP-1971 coordinate to load current state and discussion.</p></div>
    <div class="coordinate-entry" id="coordinate-entry">
      <label for="coordinate">Problem coordinate</label>
      <div><input id="coordinate" autocomplete="off" spellcheck="false" placeholder="31971:owner:problem-id" aria-describedby="setup-status"${message ? ' aria-invalid="true"' : ""}><button type="button">View problem</button></div>
      <output id="setup-status" aria-live="polite">${escapeHtml(message)}</output>
    </div>
  </section>`;
  const input = document.querySelector<HTMLInputElement>("#coordinate");
  const open = () => { if (input) void loadProblem(input.value); };
  document.querySelector("#coordinate-entry button")?.addEventListener("click", open);
  input?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    open();
  });
  if (!reducedMotion) gsap.fromTo(".setup > *", { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: .45, stagger: .07, ease: "expo.out" });
}

function showLoadingProblem() {
  recordEntrancePending = true;
  resetMedia();
  stopDiscussionSubscription();
  if (countdownTimer) clearInterval(countdownTimer);
  app.innerHTML = `<section class="setup loading-state" aria-labelledby="loading-title" aria-live="polite">
    <div class="setup-glyph" aria-hidden="true"><span></span><span></span><span></span></div>
    <div><h1 id="loading-title">Loading problem</h1><p>Finding the selected revision and its current discussion…</p></div>
  </section>`;
  if (!reducedMotion) gsap.fromTo(".loading-state > *", { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: .45, stagger: .07, ease: "expo.out" });
}

function stopDiscussionSubscription() {
  loadGeneration += 1;
  discussionSubscription?.close();
  discussionSubscription = undefined;
}

const statusLabel = (status: string) => status.charAt(0).toUpperCase() + status.slice(1);
const commentEvents = () => comments.filter(({ event }) => !event.tags.some((tag) => tag[0] === "patched"));

const displayNpub = (author: string) => {
  try {
    return pubkeyDisplay(author);
  } catch (error) {
    console.warn("Profile npub encoding failed; using shortened public key", { author, error });
    return shortKey(author);
  }
};
const authorName = (author: string) => {
  const name = profiles.get(author)?.name;
  return name && name !== author ? name : displayNpub(author);
};
const profileNameClass = (author: string) => profileLoadingAuthors.has(author) ? "profile-name-loading" : "";
const fallbackAvatar = (author: string) => `<span class="avatar generated-avatar${avatarLoadingAuthors.has(author) ? " profile-avatar-loading" : ""}" style="--avatar-hue:${pubkeyAvatarHue(author)}" aria-hidden="true">${escapeHtml(pubkeyAvatarLabel(author))}</span>`;
const authorAvatar = (author: string) => {
  const profile = profiles.get(author);
  const handle = avatarHandles.get(author);
  if (profile?.picture && handle) return `<img class="avatar" src="${escapeHtml(handle.url)}" data-avatar-author="${author}" alt="">`;
  return fallbackAvatar(author);
};

const revisionChanges = (revision: ReturnType<typeof problemRevisionHistory>[number], revisions: ReturnType<typeof problemRevisionHistory>) => {
  if (!revision.previousIds.length) return `<p class="history-note">Initial version</p>${renderChanges(compareProblemRevisions(undefined, revision))}`;
  const parents = revision.previousIds.map((id) => revisions.find((candidate) => candidate.id === id)).filter((parent) => parent !== undefined);
  if (!parents.length) return `<p class="history-note">Previous version unavailable from connected relays.</p>`;
  return parents.map((parent) => `${revision.previousIds.length > 1 ? `<p class="history-note">Compared with ${shortKey(parent.id)}</p>` : ""}${renderChanges(compareProblemRevisions(parent, revision))}`).join("");
};

const renderChanges = (changes: ReturnType<typeof compareProblemRevisions>) => changes.length
  ? `<dl class="revision-changes">${changes.map(({ field, before, after }) => `<div><dt>${field}</dt><dd>${before === undefined ? `<ins>${escapeHtml(after || "None")}</ins>` : `<del>${escapeHtml(before || "None")}</del><ins>${escapeHtml(after || "None")}</ins>`}</dd></div>`).join("")}</dl>`
  : `<p class="history-note">No visible field changes.</p>`;

function render() {
  if (!problem) return;
  stopProfileShimmers();
  resetMedia();
  const discussion = commentEvents().sort((a, b) => a.event.created_at - b.event.created_at);
  const revisions = problemRevisionHistory(problem.coordinate, relatedEvents);
  const edits = problemEdits(revisions);
  const activity = [
    ...edits.map((revision) => ({ type: "revision" as const, createdAt: revision.createdAt, revision })),
    ...discussion.map((result) => ({ type: "comment" as const, createdAt: result.event.created_at, result }))
  ].sort((a, b) => a.createdAt - b.createdAt);
  const effectiveClaim = selectEffectiveClaim(problem, comments, revisions);
  const hasChildren = hasProblemChildren(problem.coordinate, relatedEvents);
  const childrenKnown = loadStates.children === "complete";
  const claimPending = problem.status === "rfm" && Boolean(pubkey) && hasClaimRequest(problem, comments, pubkey);
  const displayedStatus = effectiveClaim ? "claimed" : problem.status;
  const canClaim = problem.status === "open" && childrenKnown && !hasChildren && Boolean(pubkey) && !effectiveClaim && !claimPending;
  const meritsAvailable = canRequestMerits(problem.status);
  const canEdit = mayEditProblem(problem, pubkey, ancestorOwners);
  const claimDetails = effectiveClaim ? `<div class="claim-summary">
    ${authorAvatar(effectiveClaim.claimant)}
    <div><span>Claimed by</span><strong class="${profileNameClass(effectiveClaim.claimant)}" title="${escapeHtml(effectiveClaim.claimant)}">${escapeHtml(authorName(effectiveClaim.claimant))}</strong></div>
    <div class="claim-deadline"><span>Time left for PR</span>${effectiveClaim.expiresAt
      ? `<time data-claim-deadline="${effectiveClaim.expiresAt}" datetime="${new Date(effectiveClaim.expiresAt * 1000).toISOString()}">${formatClaimCountdown(effectiveClaim.expiresAt - Date.now() / 1000)}</time>`
      : `<strong>Deadline unavailable</strong>`}</div>
  </div>` : "";
  app.innerHTML = `<article class="problem-view">
    <header class="topbar"><button id="change-problem" type="button">Change problem</button><div class="topbar-actions"><button id="edit-problem" type="button" ${canEdit ? "" : "disabled"} title="${canEdit ? "Edit this problem" : "Only the owner, a current maintainer, or an ancestor owner can edit this problem"}">Edit problem</button><code title="${problem.coordinate}">${shortKey(problem.problemId)}</code></div></header>
    <section class="problem-copy" aria-labelledby="problem-title">
      <div class="state-line"><span class="status status-${escapeHtml(displayedStatus)}"><i></i>${escapeHtml(statusLabel(displayedStatus))}</span></div>
      <h1 id="problem-title">${escapeHtml(problem.title)}</h1>
      <div class="problem-author">
        ${authorAvatar(problem.owner)}
        <div><span>Problem author</span><strong class="${profileNameClass(problem.owner)}" title="${escapeHtml(problem.owner)}">${escapeHtml(authorName(problem.owner))}</strong></div>
      </div>
      <div class="description markdown-body">${renderMarkdown(problem.description)}</div>
      <div class="actions">
        ${meritsAvailable
          ? `<button class="primary" id="request-merits" type="button" ${meritRequestBusy ? "disabled" : ""}>${meritRequestBusy ? "Opening…" : "Request merits"}</button>
            <span>Open merit request composer. Enter requested value as whole satoshis.</span>`
          : `<button class="primary" id="claim" type="button" ${canClaim && !busy ? "" : "disabled"}>${busy ? "Publishing…" : effectiveClaim ? "Claimed" : claimPending ? "Claim requested" : problem.status === "open" ? "Claim problem" : "Claim unavailable"}</button>
            <span>${!childrenKnown ? "Checking child problems before enabling claims…" : hasChildren ? "Problems with children cannot be claimed." : claimPending ? "This rfm problem requires author or maintainer acknowledgement." : effectiveClaim ? "Work may begin immediately." : problem.status === "open" ? "Claim gives you 24 hours to send a PR." : "This problem is not available to claim."}</span>`}
      </div>
      ${claimDetails}
      <button class="related-action" id="report-related" type="button">+ Log new problem under this one</button>
    </section>
    <section class="discussion" aria-labelledby="discussion-title">
      <h2 id="discussion-title">Discussion · ${discussion.length} comment${discussion.length === 1 ? "" : "s"}${edits.length ? ` · ${edits.length} edit${edits.length === 1 ? "" : "s"}` : ""}</h2>
      <ol>${activity.length ? activity.map((item) => item.type === "revision" ? `<li class="revision-entry${item.revision.id === problem?.revisionId ? " current" : ""}">
        ${authorAvatar(item.revision.author)}
        <details${item.revision.id === problem?.revisionId ? " open" : ""}><summary><span class="history-summary"><span><strong class="activity-kind">Edit</strong><span class="status status-${escapeHtml(item.revision.status)}"><i></i>${escapeHtml(statusLabel(item.revision.status))}</span>${item.revision.id === problem?.revisionId ? '<strong class="current-label">Current</strong>' : ""}</span><strong>${escapeHtml(item.revision.title)}</strong><small><span class="${profileNameClass(item.revision.author)}" title="${escapeHtml(item.revision.author)}">${escapeHtml(authorName(item.revision.author))}</span><time datetime="${new Date(item.revision.createdAt * 1000).toISOString()}" title="${new Date(item.revision.createdAt * 1000).toLocaleString()}">${formatRelativeTime(item.revision.createdAt)}</time><code title="${item.revision.id}">${shortKey(item.revision.id)}</code></small></span></summary>
        ${revisionChanges(item.revision, revisions)}</details>
      </li>` : `<li class="comment-entry-row">
        ${authorAvatar(item.result.event.pubkey)}
        <div><header><strong class="${profileNameClass(item.result.event.pubkey)}" title="${escapeHtml(item.result.event.pubkey)}">${escapeHtml(authorName(item.result.event.pubkey))}</strong><time datetime="${new Date(item.result.event.created_at * 1000).toISOString()}" title="${new Date(item.result.event.created_at * 1000).toLocaleString()}">${formatRelativeTime(item.result.event.created_at)}</time></header><div class="markdown-body comment-body">${renderMarkdown(item.result.event.content)}</div></div>
      </li>`).join("") : `<li class="empty">${loadStates.discussion === "loading" || loadStates.graph === "loading" ? "Loading discussion and edit history…" : loadStates.discussion === "failed" ? "Discussion unavailable. Reopen to retry." : "No discussion or edit history yet."}</li>`}</ol>
      <div class="comment-entry" id="comment-entry">
        <label class="sr-only" for="comment">Leave a comment</label>
        <textarea id="comment" rows="1" maxlength="4000" placeholder="Leave a comment…" ${pubkey && !busy ? "" : "disabled"}></textarea>
        <button id="post-comment" type="button" ${pubkey && !busy ? "" : "disabled"}>Post</button>
      </div>
    </section>
    <output id="app-status" aria-live="polite">${escapeHtml(liveMessage || backgroundStatus() || (pubkey ? "" : "Sign in through shell to claim or comment."))}</output>
  </article>`;
  bind();
  startProfileShimmers();
  void hydrateMedia(mediaRenderVersion);
  syncClaimCountdown(effectiveClaim?.expiresAt);
  if (recordEntrancePending && !reducedMotion) {
    gsap.fromTo(".problem-copy > *, .discussion", { y: 9, opacity: 0 }, { y: 0, opacity: 1, duration: .38, stagger: .045, ease: "expo.out" });
  }
  recordEntrancePending = false;
}

function stopProfileShimmers(): void {
  profileShimmerTweens.forEach((tween) => tween.kill());
  profileShimmerTweens = [];
}

function startProfileShimmers(): void {
  if (reducedMotion) return;
  const names = gsap.utils.toArray<HTMLElement>(".profile-name-loading");
  const avatars = gsap.utils.toArray<HTMLElement>(".profile-avatar-loading");
  if (names.length) {
    profileShimmerTweens.push(gsap.fromTo(names, { backgroundPositionX: "145%" }, {
      backgroundPositionX: "-45%", duration: 1.65, ease: "none", repeat: -1
    }));
  }
  if (avatars.length) {
    profileShimmerTweens.push(gsap.fromTo(avatars, { backgroundPositionX: "165%, 0%" }, {
      backgroundPositionX: "-65%, 0%", duration: 1.65, delay: .14, ease: "none", repeat: -1
    }));
  }
}

function resetMedia(): void {
  mediaRenderVersion += 1;
  mediaObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  mediaObjectUrls.clear();
}

async function hydrateMedia(version: number): Promise<void> {
  const placeholders = [...document.querySelectorAll<HTMLElement>("[data-media-url]")];
  await Promise.all(placeholders.map(async (placeholder) => {
    const url = placeholder.dataset.mediaUrl;
    const alt = placeholder.dataset.mediaAlt || "Attached media";
    if (!url) return;
    try {
      const blob = await resource.bytes(url);
      if (version !== mediaRenderVersion || !placeholder.isConnected) return;
      if (!blob.type.startsWith("image/") && !blob.type.startsWith("video/")) {
        throw new Error(`Unsupported media type: ${blob.type || "unknown"}`);
      }
      const objectUrl = URL.createObjectURL(blob);
      mediaObjectUrls.add(objectUrl);
      const replaceDecodeFailure = (element: HTMLElement, kind: "image" | "video") => {
        console.warn(`Problem ${kind} decode failed`, { url, mimeType: blob.type });
        URL.revokeObjectURL(objectUrl);
        mediaObjectUrls.delete(objectUrl);
        const fallback = document.createElement("span");
        fallback.className = "markdown-media";
        fallback.dataset.state = "error";
        fallback.textContent = `${kind === "image" ? "Image" : "Video"} unavailable: ${alt}`;
        element.replaceWith(fallback);
      };
      if (blob.type.startsWith("image/")) {
        const image = document.createElement("img");
        image.className = "problem-media";
        image.src = objectUrl;
        image.alt = alt;
        image.addEventListener("error", () => replaceDecodeFailure(image, "image"), { once: true });
        placeholder.replaceWith(image);
        return;
      }
      const video = document.createElement("video");
      video.className = "problem-media";
      video.src = objectUrl;
      video.controls = true;
      video.preload = "metadata";
      video.setAttribute("aria-label", alt);
      video.addEventListener("error", () => replaceDecodeFailure(video, "video"), { once: true });
      placeholder.replaceWith(video);
    } catch (error) {
      console.warn("Problem media load failed", { url, error });
      if (version !== mediaRenderVersion || !placeholder.isConnected) return;
      placeholder.dataset.state = "error";
      placeholder.replaceChildren(document.createTextNode(`Media unavailable: ${alt}`));
    }
  }));
}

function syncClaimCountdown(deadline?: number) {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = undefined;
  if (!deadline) return;
  const update = () => {
    const output = document.querySelector<HTMLElement>("[data-claim-deadline]");
    if (!output) return;
    const remaining = deadline - Date.now() / 1000;
    output.textContent = formatClaimCountdown(remaining);
    if (remaining > 0) return;
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = undefined;
  };
  update();
  if (deadline > Date.now() / 1000) countdownTimer = setInterval(update, 1000);
}

function bind() {
  document.querySelectorAll<HTMLImageElement>("[data-avatar-author]").forEach((image) => image.addEventListener("error", () => {
    const author = image.dataset.avatarAuthor;
    if (!author) return;
    avatarHandles.get(author)?.revoke();
    avatarHandles.delete(author);
    image.outerHTML = fallbackAvatar(author);
  }, { once: true }));
  document.querySelector("#change-problem")?.addEventListener("click", () => showSetup());
  document.querySelector("#edit-problem")?.addEventListener("click", () => void editProblem());
  document.querySelector("#claim")?.addEventListener("click", () => void publishAction("I am claiming this problem.", "claim"));
  document.querySelector("#request-merits")?.addEventListener("click", () => void requestMerits());
  document.querySelector("#report-related")?.addEventListener("click", () => void reportRelated());
  document.querySelector("#post-comment")?.addEventListener("click", () => void postComment());
  document.querySelector("#comment")?.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void postComment();
  });
}

async function publishAction(content: string, action?: "claim") {
  if (!problem || !pubkey || busy) return;
  if (action === "claim" && hasProblemChildren(problem.coordinate, relatedEvents)) {
    setLiveStatus("Problems with children cannot be claimed.");
    return;
  }
  busy = true;
  render();
  try {
    const result = await outbox.publish(buildWorkflowTemplate(problem, content, action), problem.relay ? { relays: [problem.relay], toOutbox: false } : { toInboxes: [problem.owner] });
    const acceptedRelays = Object.entries(result.relays ?? {}).filter(([, accepted]) => accepted).map(([relay]) => relay);
    if (!result.event || (!result.ok && acceptedRelays.length === 0)) {
      throw new Error(result.error ?? "Shell could not publish the event.");
    }
    receiveDiscussion({ event: result.event, sidecar: { relayHints: acceptedRelays } });
    setLiveStatus(action ? (problem.status === "rfm" ? "Claim request published; awaiting acknowledgement." : "Problem claimed. You have 24 hours to send a PR.") : "Comment published.");
  } catch (error) {
    setLiveStatus(error instanceof Error ? error.message : "Event could not be published.");
  } finally {
    busy = false;
    render();
  }
}

async function postComment() {
  const input = document.querySelector<HTMLTextAreaElement>("#comment");
  const content = input?.value.trim() ?? "";
  if (!content) { setLiveStatus("Write a comment before posting."); input?.focus(); return; }
  await publishAction(content);
}

async function requestMerits() {
  if (!problem || !canRequestMerits(problem.status) || meritRequestBusy) return;
  meritRequestBusy = true;
  render();
  setLiveStatus(`Opening merit request for ${problem.title}…`);
  try {
    const result = await openAdjacentMeritRequest(intent, problem.title);
    if (!result.ok || !result.handled) throw new Error(result.error ?? "No compatible merit request composer is available.");
    setLiveStatus(`Merit request composer opened for ${problem.title}.`);
  } catch (error) {
    console.error("Merit request intent failed", { problemId: problem.problemId, error });
    setLiveStatus(error instanceof Error ? error.message : "Merit request composer could not be opened.");
  } finally {
    meritRequestBusy = false;
    render();
    if (!reducedMotion) gsap.fromTo("#request-merits", { scale: .97 }, { scale: 1, duration: .2, ease: "expo.out" });
  }
}

async function reportRelated() {
  if (!problem) return;
  setLiveStatus("Opening related problem composer…");
  try {
    const result = await intent.invoke({ archetype: "composer", action: "problem-child", convention: "napplet:composer/problem-child", payload: { problemId: problem.problemId }, behavior: { focus: true, reuse: true } });
    if (!result.ok || !result.handled) throw new Error(result.error ?? "No compatible problem composer is available.");
    setLiveStatus("Related problem composer opened.");
  } catch (error) { setLiveStatus(error instanceof Error ? error.message : "Problem composer could not be opened."); }
}

async function editProblem() {
  if (!problem || !mayEditProblem(problem, pubkey, ancestorOwners)) return;
  setLiveStatus("Opening problem editor…");
  try {
    const result = await intent.invoke({ archetype: "composer", action: "problem-edit", convention: "napplet:composer/problem-edit", payload: { problemId: problem.problemId }, behavior: { focus: true, reuse: true } });
    if (!result.ok || !result.handled) throw new Error(result.error ?? "No compatible problem editor is available.");
    setLiveStatus("Problem editor opened.");
  } catch (error) {
    console.error("Problem editor intent failed", { problemId: problem.problemId, error });
    setLiveStatus(error instanceof Error ? error.message : "Problem editor could not be opened.");
  }
}

function setLiveStatus(message: string) {
  liveMessage = message;
  const output = document.querySelector<HTMLOutputElement>("#app-status");
  if (output) output.textContent = message;
}

function receiveDiscussion(result: RelayEventResult) {
  if (!problem) return;
  const authors = ingestResults([result], problem.coordinate);
  void loadProfiles(authors);
}

async function loadProfiles(authors: string[]) {
  const missing = [...new Set(authors)].filter((author) => !profiles.has(author) && !profileLoadingAuthors.has(author));
  if (!missing.length) return;
  missing.forEach((author) => {
    profileLoadingAuthors.add(author);
    avatarLoadingAuthors.add(author);
  });
  if (problem) render();
  try {
    const response = await outbox.query({ kinds: [0], authors: missing, limit: missing.length }, { limit: missing.length, timeoutMs: 8000 });
    const loadProfile = async (author: string) => {
      const profile = profileFromEvents(author, response.events.map(({ event }) => event));
      profileLoadingAuthors.delete(author);
      if (!profile) {
        avatarLoadingAuthors.delete(author);
        if (problem) render();
        return;
      }
      profiles.set(author, profile);
      const version = (avatarRequestVersions.get(author) ?? 0) + 1;
      avatarRequestVersions.set(author, version);
      avatarHandles.get(author)?.revoke();
      avatarHandles.delete(author);
      const resourceAvailable = Boolean((window as Window & { napplet?: { resource?: unknown } }).napplet?.resource);
      if (!profile.picture || !resourceAvailable) {
        avatarLoadingAuthors.delete(author);
        if (profile.picture && !resourceAvailable) {
          console.warn("Profile picture unavailable; shell resource domain is missing", { author });
        }
        if (problem) render();
        return;
      }
      if (problem) render();
      try {
        const blob = await resource.bytes(profile.picture);
        if (!blob.type.startsWith("image/")) {
          console.warn("Profile picture rejected; resource is not an image", { author, picture: profile.picture, mimeType: blob.type });
          return;
        }
        const url = URL.createObjectURL(blob);
        if (avatarRequestVersions.get(author) !== version) {
          URL.revokeObjectURL(url);
          return;
        }
        avatarHandles.set(author, { url, revoke: () => URL.revokeObjectURL(url) });
      } catch (error) {
        console.warn("Profile picture fetch failed; using generated avatar", { author, picture: profile.picture, error });
      } finally {
        avatarLoadingAuthors.delete(author);
        if (problem) render();
      }
    };
    const queue = [...missing];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const author = queue.shift();
        if (author) await loadProfile(author);
      }
    }));
    if (problem) render();
  } catch (error) {
    console.warn("Profile metadata query failed; using pubkey fallbacks", { authors: missing, error });
    missing.forEach((author) => {
      profileLoadingAuthors.delete(author);
      avatarLoadingAuthors.delete(author);
    });
    if (problem) render();
  }
}

async function loadChildRevisions(coordinate: string, generation: number): Promise<void> {
  if (generation !== loadGeneration) return;
  const childProblemIds = [...new Set(relatedEvents.flatMap(({ event }) =>
    event.tags.some((tag) => tag[0] === "a" && tag[3] === undefined && tag[1] === coordinate)
      ? event.tags.filter((tag) => tag[0] === "d" && tag[1]).map((tag) => tag[1])
      : []))];
  setLoadState("children", "loading");
  if (!childProblemIds.length) {
    setLoadState("children", "complete");
    return;
  }
  try {
    const response = await outbox.query(
      { kinds: [31971], "#d": childProblemIds, limit: 300 },
      { limit: 300, timeoutMs: 8000 }
    );
    if (generation !== loadGeneration) return;
    const authors = ingestResults(response.events, coordinate);
    setLoadState("children", "complete");
    void loadProfiles(authors);
  } catch (error) {
    if (generation !== loadGeneration) return;
    console.warn("Child problem revision query failed", { coordinate, childProblemIds, error });
    setLoadState("children", "failed");
  }
}

async function loadProblemGraph(
  selected: ProblemView,
  initialOwner: string,
  generation: number,
  initialFilters: Parameters<typeof outbox.subscribe>[0],
  replaceSubscription: (subscription: OutboxSubscription) => void
): Promise<void> {
  setLoadState("graph", "loading");
  try {
    const graphResponse = await outbox.query(
      { kinds: [31971], "#A": [selected.rootCoordinate], limit: 1000 },
      { limit: 1000, timeoutMs: 8000 }
    );
    if (generation !== loadGeneration) return;
    const authors = ingestResults(graphResponse.events, selected.coordinate);
    setLoadState("graph", "complete");
    void loadProfiles(authors);
    const current = problem;
    if (!current) return;
    setLoadState("ancestors", "loading");
    try {
      await hydrateProblemAncestors(current, generation);
      if (generation !== loadGeneration) return;
      const unresolved = missingProblemAncestorCoordinates(current, relatedEvents);
      if (unresolved.length) throw new Error(`Ancestor problems remain unavailable: ${unresolved.join(", ")}`);
      refreshAncestorOwners(selected.coordinate);
      setLoadState("ancestors", "complete");
    } catch (error) {
      if (generation !== loadGeneration) return;
      console.warn("Problem ancestor background query failed", { coordinate: selected.coordinate, error });
      setLoadState("ancestors", "failed");
    }

    if (generation !== loadGeneration || !problem) return;
    const routedAuthors = [...new Set([...problemRevisionAuthors(problem), ...ancestorOwners])];
    if (!routedAuthors.some((author) => author !== initialOwner)) return;
    const expandedFilters = [
      ...(Array.isArray(initialFilters) ? initialFilters : [initialFilters]),
      { kinds: [31971], "#A": [problem.rootCoordinate] }
    ];
    const nextSubscription = outbox.subscribe(expandedFilters, { authors: routedAuthors, timeoutMs: 8000 });
    replaceSubscription(nextSubscription);
    nextSubscription.on("event", (result) => {
      if (generation !== loadGeneration || discussionSubscription !== nextSubscription) return;
      const nextAuthors = ingestResults([result], selected.coordinate);
      void loadProfiles(nextAuthors);
    });
    nextSubscription.on("closed", (reason) => {
      if (generation !== loadGeneration || discussionSubscription !== nextSubscription) return;
      discussionSubscription = undefined;
      console.warn("Expanded live problem subscription closed", { coordinate: selected.coordinate, reason });
      setLiveStatus("Live updates stopped. Reopen problem to reconnect.");
    });
    const routedResponse = await outbox.query(
      { kinds: [31971], "#d": [selected.problemId], limit: 200 },
      { authors: routedAuthors, limit: 200, timeoutMs: 8000 }
    );
    if (generation !== loadGeneration) return;
    const routedProfiles = ingestResults(routedResponse.events, selected.coordinate);
    void loadProfiles(routedProfiles);
  } catch (error) {
    if (generation !== loadGeneration) return;
    console.warn("Problem graph background query failed", { coordinate: selected.coordinate, error });
    setLoadState("graph", "failed");
    setLoadState("ancestors", "failed");
  }
}

async function loadProblem(value: string) {
  const status = document.querySelector<HTMLOutputElement>("#setup-status");
  let generation = loadGeneration;
  try {
    const target = parseCoordinate(value);
    if (status) status.textContent = "Loading current revision…";
    stopDiscussionSubscription();
    generation = loadGeneration;
    problem = undefined;
    resetResults();
    ancestorOwners = [];
    liveMessage = "";
    let filters = [
      { kinds: [31971], "#d": [target.problemId] },
      { kinds: [COMMENT_KIND], "#A": [target.coordinate] },
      { kinds: [31971], "#a": [target.coordinate] }
    ];
    const receiveInitial = (result: RelayEventResult) => {
      if (generation !== loadGeneration) return;
      const authors = ingestResults([result], target.coordinate);
      if (problem) authors.push(problem.owner);
      void loadProfiles(authors);
    };
    const subscribe = (authors: string[]) => {
      const subscription = outbox.subscribe(filters, { authors, timeoutMs: 8000 });
      discussionSubscription = subscription;
      subscription.on("event", (result) => {
        if (discussionSubscription !== subscription) return;
        receiveInitial(result);
      });
      subscription.on("closed", (reason) => {
        if (discussionSubscription !== subscription) return;
        discussionSubscription = undefined;
        console.warn("Live problem subscription closed", { coordinate: target.coordinate, reason });
        setLiveStatus("Live updates stopped. Reopen problem to reconnect.");
      });
      return subscription;
    };
    let subscription = subscribe([target.owner]);
    const problemFilter = { kinds: [31971], "#d": [target.problemId], limit: 200 };
    setLoadState("problem", "loading");
    setLoadState("discussion", "loading");
    const discussionPromise = outbox.query(filters.slice(1), { authors: [target.owner], limit: 300, timeoutMs: 8000 })
      .then((response) => {
        if (generation !== loadGeneration) return;
        const authors = ingestResults(response.events, target.coordinate);
        setLoadState("discussion", "complete");
        void loadProfiles(authors);
        void loadChildRevisions(target.coordinate, generation);
      }).catch((error: unknown) => {
        if (generation !== loadGeneration) return;
        console.warn("Problem discussion background query failed", { coordinate: target.coordinate, error });
        setLoadState("discussion", "failed");
        setLoadState("children", "failed");
      });
    void discussionPromise;
    const problemResponse = await outbox.query(problemFilter, { authors: [target.owner], limit: 200, timeoutMs: 8000 });
    if (generation !== loadGeneration) return;
    const authors = ingestResults(problemResponse.events, target.coordinate);
    const loadedProblem = selectProblem(target.coordinate, relatedEvents);
    problem = loadedProblem;
    setLoadState("problem", "complete");
    void loadProfiles([...authors, loadedProblem.owner]);
    void loadProblemGraph(loadedProblem, target.owner, generation, filters, (next) => {
      const previous = subscription;
      subscription = next;
      discussionSubscription = next;
      previous.close();
    });
  } catch (error) {
    if (generation !== loadGeneration) return;
    console.error("Problem load failed", { value, error });
    setLoadState("problem", "failed");
    if (problem) {
      setLiveStatus("Current problem query failed. Showing locally received data; reopen to retry.");
      return;
    }
    showSetup(error instanceof Error ? error.message : "Problem could not be loaded.");
  }
}

function isNoteOpenPayload(payload: unknown): payload is { target: { type: "event"; id: string } } {
  if (typeof payload !== "object" || payload === null) return false;
  const target = (payload as { target?: unknown }).target;
  return typeof target === "object" && target !== null &&
    (target as { type?: unknown }).type === "event" &&
    typeof (target as { id?: unknown }).id === "string" && /^[0-9a-f]{64}$/.test((target as { id: string }).id);
}

async function openProblemRevision(revisionId: string) {
  try {
    const response = await outbox.query({ ids: [revisionId], kinds: [31971], limit: 1 }, { limit: 1, timeoutMs: 8000 });
    const selected = response.events.find(({ event }) => event.id === revisionId)?.event;
    if (!selected) throw new Error("Selected problem revision was not found.");
    await loadProblem(coordinateFromProblemEvent(selected));
  } catch (error) {
    showSetup(error instanceof Error ? error.message : "Selected problem could not be opened.");
  }
}

async function start() {
  showSetup();
  try {
    intentSubscription = inc.on("napplet:note/open", (event) => {
      intentReceived = true;
      if (!isNoteOpenPayload(event.payload)) {
        showSetup("Incoming problem-open request has an invalid event target.");
        return;
      }
      showLoadingProblem();
      void openProblemRevision(event.payload.target.id);
    });
  } catch (error) {
    console.error("Problem-open intent subscription failed", { error });
    liveMessage = "Shell intent delivery unavailable. Paste a problem coordinate to continue.";
  }
  try {
    pubkey = await identity.getPublicKey();
    identitySubscription = identity.onChanged((next) => { pubkey = next; if (problem) render(); });
  } catch (error) {
    console.error("Shell identity initialization failed", { error });
    pubkey = "";
    liveMessage = "Shell identity unavailable. Viewing remains available; publishing is disabled.";
    if (!intentReceived && !problem) showSetup(liveMessage);
  }
}

addEventListener("beforeunload", () => {
  stopProfileShimmers();
  discussionSubscription?.close(); identitySubscription?.close(); intentSubscription?.close();
  if (countdownTimer) clearInterval(countdownTimer);
  avatarHandles.forEach((handle) => handle.revoke());
  avatarRequestVersions.clear();
  resetMedia();
});
void start();
