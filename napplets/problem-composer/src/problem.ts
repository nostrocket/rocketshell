/*
  Shared NIP-1971 problem-event primitives used by both composer modes.

  This module is the single home for the event-shape logic that the genesis
  composer and the revision editor used to each re-implement: tag lookup,
  current-head selection, direct-parent reads, ancestor-owner resolution, child
  detection, graph-root lookup, and the intent payload validator.
*/
import type { NostrEvent, RelayEventResult } from "@napplet/sdk";

export const PROBLEM_KIND = 31971;
export const HEX_64 = /^[0-9a-f]{64}$/;
export const PROBLEM_COORDINATE = /^31971:[0-9a-f]{64}:[0-9a-f]{64}$/;

/** Every workflow state a kind-31971 revision may carry. */
export const STATUSES = ["draft", "rfm", "big", "children", "open", "claimed", "patched", "closed"] as const;
export type ProblemStatus = typeof STATUSES[number];

/** The subset offered when creating a fresh root or child problem. */
export const GENESIS_STATUSES = ["draft", "rfm", "big", "children", "open", "closed"] as const;
export type GenesisStatus = typeof GENESIS_STATUSES[number];

export type ChildDefaultStatus = "rfm" | "open";

export const tag = (event: NostrEvent, name: string, marker?: string) =>
  event.tags.find((item) => item[0] === name && (marker === undefined || item[3] === marker));

export const tagValue = (event: NostrEvent, name: string, marker?: string) => tag(event, name, marker)?.[1];

export const directParentCoordinates = (event: NostrEvent): string[] => event.tags
  .filter((item) => item[0] === "a" && item[3] === undefined && PROBLEM_COORDINATE.test(item[1] ?? ""))
  .map((item) => item[1]);

export const rootCoordinate = (event: NostrEvent): string => {
  const root = tagValue(event, "A") ?? "";
  if (!PROBLEM_COORDINATE.test(root)) throw new Error("Problem graph root is invalid.");
  return root;
};

/** Newest eligible head, or undefined when owners/maintainers fork. */
export const selectCurrentHead = (candidates: RelayEventResult[]): RelayEventResult | undefined => {
  const referenced = new Set(candidates.flatMap(({ event }) => event.tags
    .filter((item) => item[0] === "e" && item[3] === "previous").map((item) => item[1])));
  const eligible = candidates.filter(({ event }) => {
    if (referenced.has(event.id)) return false;
    const owner = tagValue(event, "a", "origin")?.split(":")[1] ?? "";
    return event.pubkey === owner || event.tags.some((item) =>
      item[0] === "p" && item[1] === event.pubkey && (item[3] === "maintainer" || item[3] === undefined));
  });
  if (!eligible.length) return undefined;
  const newestTimestamp = Math.max(...eligible.map(({ event }) => event.created_at));
  const newest = eligible.filter(({ event }) => event.created_at === newestTimestamp);
  return newest.length === 1 ? newest[0] : undefined;
};

export const currentHead = (coordinate: string, results: RelayEventResult[]): RelayEventResult => {
  const problemId = coordinate.split(":")[2] ?? "";
  const candidates = results.filter(({ event }) => event.kind === PROBLEM_KIND &&
    tagValue(event, "d") === problemId && tagValue(event, "a", "origin") === coordinate);
  if (!candidates.length) throw new Error(`Ancestor problem ${problemId} was not found.`);
  const selected = selectCurrentHead(candidates);
  if (!selected) throw new Error(`Ancestor problem ${problemId} has unresolved revision forks.`);
  return selected;
};

export function resolveAncestorOwners(event: NostrEvent, results: RelayEventResult[]): string[] {
  const owners = new Set<string>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (coordinate: string) => {
    if (visiting.has(coordinate)) throw new Error("Problem ancestry contains a cycle.");
    if (visited.has(coordinate)) return;
    visiting.add(coordinate);
    const owner = coordinate.split(":")[1] ?? "";
    if (!HEX_64.test(owner)) throw new Error("Ancestor problem owner is invalid.");
    const head = currentHead(coordinate, results).event;
    owners.add(owner);
    for (const parent of directParentCoordinates(head)) visit(parent);
    visiting.delete(coordinate);
    visited.add(coordinate);
  };
  for (const parent of directParentCoordinates(event)) visit(parent);
  return [...owners].sort();
}

export function hasProblemChildren(coordinate: string, results: RelayEventResult[]): boolean {
  const candidates = results.filter(({ event }) => event.kind === PROBLEM_KIND && HEX_64.test(event.id) &&
    PROBLEM_COORDINATE.test(tagValue(event, "a", "origin") ?? ""));
  const revisionsByCoordinate = new Map<string, RelayEventResult[]>();
  for (const result of candidates) {
    const childCoordinate = tagValue(result.event, "a", "origin")!;
    revisionsByCoordinate.set(childCoordinate, [...(revisionsByCoordinate.get(childCoordinate) ?? []), result]);
  }
  return [...revisionsByCoordinate.values()].some((revisions) => selectCurrentHead(revisions)?.event.tags
    .some((item) => item[0] === "a" && item[3] === undefined && item[1] === coordinate));
}

export function problemGraphRoot(problemId: string, results: RelayEventResult[]): string {
  const candidates = results.filter(({ event }) => event.kind === PROBLEM_KIND && tagValue(event, "d") === problemId);
  if (!candidates.length) throw new Error("Problem was not found.");
  const selected = selectCurrentHead(candidates);
  if (!selected) throw new Error("Problem has unresolved current heads.");
  const root = tagValue(selected.event, "A");
  if (!PROBLEM_COORDINATE.test(root ?? "")) throw new Error("Problem graph root is invalid.");
  return root!;
}

/** Both composer conventions deliver exactly one lowercase 64-char problem id. */
export function isProblemIdPayload(payload: unknown): payload is { problemId: string } {
  if (typeof payload !== "object" || payload === null) return false;
  const keys = Object.keys(payload);
  return keys.length === 1 && keys[0] === "problemId" &&
    typeof (payload as { problemId?: unknown }).problemId === "string" &&
    HEX_64.test((payload as { problemId: string }).problemId);
}

/** Relay hint for a result: transport sidecar first, then any `wss://` tag hint. */
export const relayHint = (result: RelayEventResult): string =>
  result.sidecar?.relayHints?.[0] ??
  result.event.tags.find((item) => item.length > 2 && item[2]?.startsWith("wss://"))?.[2] ?? "";

/** Relay hint for a result: transport sidecar first, then the event's own origin relay. */
export const originRelay = (result: RelayEventResult): string =>
  result.sidecar?.relayHints?.[0] ?? tag(result.event, "a", "origin")?.[2] ?? "";
