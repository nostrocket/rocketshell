export interface ChoiceEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
}

export interface ChoiceResult {
  event: ChoiceEvent;
  sidecar?: { relayHints?: string[] };
}

export interface RocketReferenceChoice {
  coordinate: string;
  relay: string;
  title: string;
  summary: string;
  createdAt: number;
  depth?: number;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const PROBLEM_COORDINATE = /^31971:[0-9a-f]{64}:[0-9a-f]{64}$/;
export const ROOT_PROBLEM_COORDINATE = "31971:d91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075:7cff61a9f7565ed63c1213040fe0f39c7f2ee1dd4fb96a41e95de049a8dcc170";

function tag(event: ChoiceEvent, name: string, marker?: string): string[] | undefined {
  return event.tags.find((item) => item[0] === name && (marker === undefined || item[3] === marker));
}

function isRelayHint(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "wss:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch (error) {
    console.warn("Rocket reference relay hint validation failed", { value, error });
    return false;
  }
}

function relayHint(result: ChoiceResult, eventHint: string | undefined, fallbackRelays: readonly string[]): string {
  return result.sidecar?.relayHints?.find(isRelayHint)
    ?? (isRelayHint(eventHint) ? eventHint : undefined)
    ?? fallbackRelays.find(isRelayHint)
    ?? "";
}

function newest(results: ChoiceResult[]): ChoiceResult {
  return [...results].sort((left, right) =>
    right.event.created_at - left.event.created_at || right.event.id.localeCompare(left.event.id))[0]!;
}

function problemCoordinate(result: ChoiceResult): string {
  return tag(result.event, "a", "origin")?.[1] ?? "";
}

function eligibleProblemHead(result: ChoiceResult): boolean {
  const owner = problemCoordinate(result).split(":")[1] ?? "";
  return result.event.pubkey === owner || result.event.tags.some((item) =>
    item[0] === "p" && item[1] === result.event.pubkey && (item[3] === "maintainer" || item[3] === undefined));
}

function problemHead(results: ChoiceResult[], _coordinate: string): ChoiceResult {
  const referenced = new Set(results.flatMap(({ event }) => event.tags
    .filter((item) => item[0] === "e" && item[3] === "previous")
    .map((item) => item[1])
    .filter((id): id is string => Boolean(id))));
  const heads = results.filter(({ event }) => !referenced.has(event.id));
  const eligible = heads.filter(eligibleProblemHead);
  const newestTimestamp = eligible.length ? Math.max(...eligible.map(({ event }) => event.created_at)) : undefined;
  const current = eligible.filter(({ event }) => event.created_at === newestTimestamp);
  if (current.length === 1) return current[0]!;
  if (current.length > 1) return newest(current);
  if (eligible.length) return newest(eligible);
  return newest(results);
}

function excerpt(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return fallback;
  return [...normalized].slice(0, 180).join("");
}

export function problemChoices(results: readonly ChoiceResult[], fallbackRelays: readonly string[] = []): RocketReferenceChoice[] {
  const groups = new Map<string, ChoiceResult[]>();
  const uniqueResults = new Map(results.map((result) => [result.event.id, result]));
  for (const result of uniqueResults.values()) {
    const { event } = result;
    const coordinate = problemCoordinate(result);
    if (event.kind !== 31971 || !PROBLEM_COORDINATE.test(coordinate)) continue;
    const problemId = tag(event, "d")?.[1]?.trim();
    if (!problemId || !HEX_64.test(problemId) || coordinate.split(":")[2] !== problemId) continue;
    const group = groups.get(coordinate) ?? [];
    group.push(result);
    groups.set(coordinate, group);
  }
  if (!groups.size) return [];

  const choices = new Map<string, RocketReferenceChoice>();
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const [coordinate, group] of groups) {
    const current = problemHead(group, coordinate);
    const title = tag(current.event, "title")?.[1]?.trim() || excerpt(current.event.content, "Untitled problem");
    choices.set(coordinate, {
      coordinate,
      relay: relayHint(current, tag(current.event, "a", "origin")?.[2], fallbackRelays),
      title,
      summary: excerpt(current.event.content, "No problem description."),
      createdAt: current.event.created_at
    });
    for (const item of current.event.tags) {
      const parent = item[0] === "a" && item[3] !== "origin" ? item[1] : undefined;
      if (!parent || !PROBLEM_COORDINATE.test(parent) || parent === coordinate || !groups.has(parent)) continue;
      const siblings = children.get(parent) ?? [];
      if (!siblings.includes(coordinate)) siblings.push(coordinate);
      children.set(parent, siblings);
      hasParent.add(coordinate);
    }
  }
  for (const siblings of children.values()) siblings.sort((left, right) =>
    choices.get(left)!.title.localeCompare(choices.get(right)!.title) || left.localeCompare(right));

  const ordered: RocketReferenceChoice[] = [];
  const seen = new Set<string>();
  const visit = (coordinate: string, depth: number): void => {
    if (seen.has(coordinate)) return;
    seen.add(coordinate);
    const choice = choices.get(coordinate);
    if (!choice) return;
    ordered.push({ ...choice, depth });
    for (const child of children.get(coordinate) ?? []) visit(child, depth + 1);
  };

  const rootCoordinates = [...choices.keys()].filter((coordinate) => {
    if (hasParent.has(coordinate)) return false;
    const current = problemHead(groups.get(coordinate)!, coordinate);
    const rootTag = tag(current.event, "A")?.[1];
    if (rootTag && rootTag !== coordinate && groups.has(rootTag)) {
      return false;
    }
    return true;
  });

  rootCoordinates.sort((left, right) => {
    if (left === ROOT_PROBLEM_COORDINATE) return -1;
    if (right === ROOT_PROBLEM_COORDINATE) return 1;
    return choices.get(left)!.title.localeCompare(choices.get(right)!.title) || left.localeCompare(right);
  });

  for (const root of rootCoordinates) {
    visit(root, 0);
  }

  return ordered;
}

export function repositoryChoices(results: readonly ChoiceResult[], pubkey: string, fallbackRelays: readonly string[] = []): RocketReferenceChoice[] {
  const groups = new Map<string, ChoiceResult[]>();
  for (const result of results) {
    const { event } = result;
    const identifier = tag(event, "d")?.[1]?.trim();
    if (event.kind !== 30617 || event.pubkey !== pubkey || !identifier) continue;
    const group = groups.get(identifier) ?? [];
    group.push(result);
    groups.set(identifier, group);
  }

  return [...groups.entries()].map(([identifier, group]) => {
    const current = newest(group);
    return {
      coordinate: `30617:${pubkey}:${identifier}`,
      relay: relayHint(current, undefined, fallbackRelays),
      title: tag(current.event, "name")?.[1]?.trim() || identifier,
      summary: excerpt(tag(current.event, "description")?.[1] ?? "", "No repository description."),
      createdAt: current.event.created_at
    };
  }).sort((left, right) => right.createdAt - left.createdAt || left.title.localeCompare(right.title));
}
