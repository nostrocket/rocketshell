/*
  Genesis composer logic: resolve a parent (or none) and build a kind-31971
  root/child problem template. Extracted from the former log-new-problem
  napplet, now sharing primitives with the revision editor.
*/
import type { EventTemplate, RelayEventResult } from "@napplet/sdk";
import {
  HEX_64, PROBLEM_KIND, relayHint, resolveAncestorOwners, selectCurrentHead,
  tag, tagValue, type ChildDefaultStatus, type GenesisStatus
} from "./problem";

export const CHILD_CONVENTION = "napplet:composer/problem-child";

export interface ParentContext {
  problemId: string;
  title: string;
  owner: string;
  revisionAuthor: string;
  revisionId: string;
  genesisId: string;
  relay: string;
  rootCoordinate: string;
  rootGenesisId: string;
  rootOwner: string;
  rootRelay: string;
  ancestorOwners: string[];
  defaultChildStatus: ChildDefaultStatus;
}

export interface ProblemDraft {
  title: string;
  description: string;
  status: GenesisStatus;
  childStatus?: ChildDefaultStatus;
  maintainers: string[];
  rocket?: { owner: string; id: string; relay: string };
  repository?: { owner: string; id: string; relay: string };
  bitcoin?: { height: string; hash: string };
}

export function normalizeProblemText(title: string, description: string) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error("Add a problem title.");
  return { title: normalizedTitle, description: description.trim() };
}

export function resolveParent(problemId: string, results: RelayEventResult[]): ParentContext {
  const candidates = results.filter(({ event }) =>
    event.kind === PROBLEM_KIND && tagValue(event, "d") === problemId && HEX_64.test(event.id));
  if (!candidates.length) throw new Error("Parent problem was not found.");

  const selected = selectCurrentHead(candidates);
  if (!selected) throw new Error("Parent has unresolved current heads.");
  const event = selected.event;
  const origin = tag(event, "a", "origin");
  if (!origin || !origin[1]?.startsWith(`${PROBLEM_KIND}:`)) throw new Error("Parent has no valid origin tag.");
  const [, owner = ""] = origin[1].split(":");
  if (!HEX_64.test(owner)) throw new Error("Parent owner is invalid.");

  const genesisId = tagValue(event, "e", "genesis") ?? event.id;
  const rootCoordinate = tagValue(event, "A") ?? origin[1];
  const [, rootOwner = ""] = rootCoordinate.split(":");
  const rootGenesisId = tagValue(event, "E") ?? genesisId;
  const rootOwnerTag = tagValue(event, "P") ?? rootOwner;
  if (!HEX_64.test(genesisId) || !HEX_64.test(rootGenesisId) || !HEX_64.test(rootOwnerTag)) {
    throw new Error("Parent graph-root references are invalid.");
  }

  const ancestorOwners = resolveAncestorOwners(event, results);

  return {
    problemId,
    title: tagValue(event, "title") ?? "Untitled parent",
    owner,
    revisionAuthor: event.pubkey,
    revisionId: event.id,
    genesisId,
    relay: relayHint(selected),
    rootCoordinate,
    rootGenesisId,
    rootOwner: rootOwnerTag,
    rootRelay: tag(event, "A")?.[2] || relayHint(selected),
    ancestorOwners: [owner, ...ancestorOwners.filter((ancestor) => ancestor !== owner)],
    defaultChildStatus: tagValue(event, "child_status") === "rfm" ? "rfm" : "open"
  };
}

/** Graph root for a parent problem, used to fetch the whole DAG before composing. */
export function parentGraphRoot(problemId: string, results: RelayEventResult[]): string {
  const candidates = results.filter(({ event }) => event.kind === PROBLEM_KIND && tagValue(event, "d") === problemId);
  if (!candidates.length) throw new Error("Parent problem was not found.");
  const selected = selectCurrentHead(candidates);
  if (!selected) throw new Error("Parent has unresolved current heads.");
  const root = tagValue(selected.event, "A");
  if (!/^31971:[0-9a-f]{64}:[0-9a-f]{64}$/.test(root ?? "")) throw new Error("Parent graph root is invalid.");
  return root!;
}

export function createProblemId(random: Uint8Array): string {
  if (random.length !== 32) throw new Error("Problem IDs require 32 random bytes.");
  return Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildProblemTemplate(
  pubkey: string,
  problemId: string,
  draft: ProblemDraft,
  createdAt: number,
  parent?: ParentContext
): EventTemplate {
  if (!HEX_64.test(pubkey) || !HEX_64.test(problemId)) throw new Error("Problem identity is invalid.");
  const coordinate = `${PROBLEM_KIND}:${pubkey}:${problemId}`;
  const tags: string[][] = [
    ["d", problemId],
    ["title", draft.title.trim()],
    ["status", draft.status],
    ["a", coordinate, "", "origin"]
  ];

  if (parent) {
    tags.push(
      ["A", parent.rootCoordinate, parent.rootRelay],
      ["E", parent.rootGenesisId, parent.rootRelay, parent.rootOwner],
      ["K", String(PROBLEM_KIND)],
      ["P", parent.rootOwner, parent.rootRelay],
      ["a", `${PROBLEM_KIND}:${parent.owner}:${parent.problemId}`, parent.relay],
      ["e", parent.genesisId, parent.relay, parent.owner],
      ["k", String(PROBLEM_KIND)],
      ["p", parent.owner, parent.relay]
    );
  } else {
    tags.push(
      ["A", coordinate, ""],
      ["K", String(PROBLEM_KIND)],
      ["P", pubkey, ""]
    );
  }

  const requiredMaintainers = new Set([pubkey, ...(parent?.ancestorOwners ?? []), ...draft.maintainers]);
  for (const maintainer of requiredMaintainers) tags.push(["p", maintainer, "", "maintainer"]);
  if (draft.childStatus) tags.push(["child_status", draft.childStatus]);
  if (draft.rocket) tags.push(["a", `31108:${draft.rocket.owner}:${draft.rocket.id}`, draft.rocket.relay, "rocket"]);
  if (draft.repository) tags.push(["a", `30617:${draft.repository.owner}:${draft.repository.id}`, draft.repository.relay, "repository"]);
  if (draft.bitcoin) tags.push(["bitcoin", draft.bitcoin.height, draft.bitcoin.hash]);

  return { kind: PROBLEM_KIND, content: draft.description.trim(), tags, created_at: createdAt };
}
