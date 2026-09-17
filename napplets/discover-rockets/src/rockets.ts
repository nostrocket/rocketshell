export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type RocketReference = { coordinate: string; relay?: string };

export type Rocket = {
  /** Addressable coordinate `31108:<author pubkey>:<identifier>`. */
  coordinate: string;
  /** The `d` tag value identifying this rocket. */
  identifier: string;
  author: string;
  /** `"this"` marks a root rocket; any other value is the parent rocket coordinate. */
  parent: string;
  mission?: string;
  problem?: RocketReference;
  repo?: RocketReference;
  createdAt: number;
  event: NostrEvent;
};

export type RocketNode = {
  rocket: Rocket;
  children: RocketNode[];
  /** Nesting depth inside the displayed forest; roots are 0. */
  depth: number;
  /** True when the declared parent coordinate is missing from the discovered set (or a cycle was broken). */
  detached: boolean;
};

const HEX_64 = /^[0-9a-f]{64}$/;

function tagValue(event: NostrEvent, name: string): string | undefined {
  const value = event.tags.find(([tag]) => tag === name)?.[1]?.trim();
  return value || undefined;
}

function tagReference(event: NostrEvent, name: string): RocketReference | undefined {
  const tag = event.tags.find(([tagName]) => tagName === name);
  const coordinate = tag?.[1]?.trim();
  if (!coordinate) return undefined;
  const relay = tag?.[2]?.trim();
  return relay ? { coordinate, relay } : { coordinate };
}

/** Parse one kind 31108 event into a rocket; returns undefined for events that cannot name a rocket. */
export function parseRocket(event: NostrEvent): Rocket | undefined {
  if (event.kind !== 31108 || !HEX_64.test(event.pubkey)) return undefined;
  const identifier = tagValue(event, "d");
  if (!identifier) return undefined;
  return {
    coordinate: `31108:${event.pubkey}:${identifier}`,
    identifier,
    author: event.pubkey,
    parent: tagValue(event, "parent") ?? "this",
    mission: tagValue(event, "mission"),
    problem: tagReference(event, "problem"),
    repo: tagReference(event, "repo"),
    createdAt: event.created_at,
    event
  };
}

/**
 * Deduplicate kind 31108 events into the latest head per rocket coordinate.
 * The newest `created_at` wins; identical timestamps fall back to the lexically larger event id.
 */
export function rocketsFromEvents(events: readonly NostrEvent[]): Rocket[] {
  const latest = new Map<string, Rocket>();
  for (const event of events) {
    const rocket = parseRocket(event);
    if (!rocket) continue;
    const current = latest.get(rocket.coordinate);
    if (!current || rocket.createdAt > current.createdAt || (rocket.createdAt === current.createdAt && rocket.event.id > current.event.id)) {
      latest.set(rocket.coordinate, rocket);
    }
  }
  return [...latest.values()];
}

const byIdentifier = (left: RocketNode, right: RocketNode): number =>
  left.rocket.identifier.localeCompare(right.rocket.identifier) || left.rocket.coordinate.localeCompare(right.rocket.coordinate);

/**
 * Build the multi-root forest from discovered rockets.
 * Roots are rockets whose `parent` tag is `"this"`; rockets whose parent coordinate is absent
 * from the discovered set surface as detached roots so they stay visible. Parent cycles cannot
 * represent a valid hierarchy, so members are rescued as detached roots and back-edges are dropped.
 */
export function forestFromRockets(rockets: readonly Rocket[]): RocketNode[] {
  const nodes = new Map<string, RocketNode>();
  for (const rocket of rockets) nodes.set(rocket.coordinate, { rocket, children: [], depth: 0, detached: false });

  const roots: RocketNode[] = [];
  for (const node of nodes.values()) {
    const { parent } = node.rocket;
    if (parent === "this") {
      roots.push(node);
      continue;
    }
    const parentNode = nodes.get(parent);
    if (parentNode && parentNode !== node) parentNode.children.push(node);
  }

  // Reachability rescue: rockets unreachable from a `"this"` root (detached parents, cycles)
  // are promoted to detached roots instead of being dropped from the discovery view.
  const visited = new Set<RocketNode>();
  const visit = (node: RocketNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  for (const node of nodes.values()) {
    if (visited.has(node)) continue;
    node.detached = true;
    roots.push(node);
    visit(node);
  }

  // Assign depths and sort siblings; lineage tracking drops back-edges that would recurse forever.
  const arrange = (node: RocketNode, depth: number, lineage: ReadonlySet<RocketNode>): void => {
    node.depth = depth;
    node.children = node.children.filter((child) => !lineage.has(child)).sort(byIdentifier);
    const path = new Set(lineage).add(node);
    for (const child of node.children) arrange(child, depth + 1, path);
  };
  roots.sort(byIdentifier);
  for (const root of roots) arrange(root, 0, new Set());
  return roots;
}

/**
 * Filter the forest by identifier or mission text (case-insensitive substring).
 * A matching node keeps its whole subtree; non-matching nodes survive only as
 * ancestors of matches so the hierarchy path stays visible.
 */
export function filterForest(roots: readonly RocketNode[], query: string): RocketNode[] {
  const needle = query.trim().toLocaleLowerCase("en-US");
  if (!needle) return [...roots];
  const keep = (node: RocketNode): RocketNode | undefined => {
    const haystack = `${node.rocket.identifier}\n${node.rocket.mission ?? ""}`.toLocaleLowerCase("en-US");
    if (haystack.includes(needle)) return node;
    const children = node.children.flatMap((child) => {
      const kept = keep(child);
      return kept ? [kept] : [];
    });
    return children.length ? { ...node, children } : undefined;
  };
  return roots.flatMap((root) => {
    const kept = keep(root);
    return kept ? [kept] : [];
  });
}

/** Aggregate display statistics over the (possibly filtered) forest. */
export function forestStats(roots: readonly RocketNode[]): { rockets: number; roots: number; maxDepth: number } {
  let rockets = 0;
  let maxDepth = 0;
  const walk = (node: RocketNode): void => {
    rockets += 1;
    if (node.depth > maxDepth) maxDepth = node.depth;
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return { rockets, roots: roots.length, maxDepth };
}
