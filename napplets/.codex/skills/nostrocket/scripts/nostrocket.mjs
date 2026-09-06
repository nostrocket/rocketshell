#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT_ID = "7cff61a9f7565ed63c1213040fe0f39c7f2ee1dd4fb96a41e95de049a8dcc170";
export const ROOT_OWNER = "d91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075";
export const ROOT_COORDINATE = `31971:${ROOT_OWNER}:${ROOT_ID}`;
export const BOOTSTRAP_RELAYS = [
  "wss://purplepag.es",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://bucket.coracle.social",
];
const CLAIM_SECONDS = 86_400;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(scriptDirectory, "../../../../..");
const sessionDirectory = path.join(homedir(), ".config", "nostrocket");
const sessionPath = path.join(sessionDirectory, "notary-nip46.nbunksec");

const usage = () => {
  console.error("usage: nostrocket.sh actionable | inspect <problem-id> | children <problem-id> | claim <problem-id> | patch <problem-id> --proof <https-url> | connect");
  process.exitCode = 2;
};

const run = (command, args, input) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => reject(new Error(`${command} could not start: ${error.message}`)));
  child.on("close", (code) => {
    if (code === 0) resolve({ stdout, stderr });
    else reject(new Error(`${command} exited ${code}: ${stderr.trim() || "no diagnostic"}`));
  });
  child.stdin.end(input);
});

const parseJsonLines = (text, operation) => {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${operation} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return events;
};

const query = async (args, operation, input) => {
  const { stdout } = await run("nak", ["req", ...args], input);
  return parseJsonLines(stdout, operation);
};

const uniqueEvents = (events) => [...new Map(events.filter((event) => event?.id).map((event) => [event.id, event])).values()];
const tagsNamed = (event, name) => event.tags?.filter((tag) => tag[0] === name) ?? [];
const tagValue = (event, name) => tagsNamed(event, name)[0]?.[1];
const originCoordinate = (event) => event.tags?.find((tag) => tag[0] === "a" && tag[3] === "origin")?.[1];
const parentCoordinates = (event) => (event.tags ?? [])
  .filter((tag) => tag[0] === "a" && tag.length < 4 && /^31971:[0-9a-f]{64}:[0-9a-f]{64}$/.test(tag[1] ?? ""))
  .map((tag) => tag[1]);

const eligibleRevision = (event) => {
  const coordinate = originCoordinate(event);
  const owner = coordinate?.split(":")[1];
  if (!owner) return false;
  if (event.pubkey === owner) return true;
  return (event.tags ?? []).some((tag) => tag[0] === "p" && tag[1] === event.pubkey && (tag[3] === undefined || tag[3] === "maintainer"));
};

export const selectCurrentNodes = (inputEvents) => {
  const events = uniqueEvents(inputEvents).filter((event) => event.kind === 31971 && originCoordinate(event));
  const groups = new Map();
  for (const event of events) {
    const coordinate = originCoordinate(event);
    const revisions = groups.get(coordinate) ?? [];
    revisions.push(event);
    groups.set(coordinate, revisions);
  }

  const nodes = new Map();
  for (const [coordinate, revisions] of groups) {
    const previous = new Set(revisions.flatMap((event) => tagsNamed(event, "e").filter((tag) => tag[3] === "previous").map((tag) => tag[1])));
    const eligibleHeads = revisions.filter((event) => !previous.has(event.id) && eligibleRevision(event));
    if (eligibleHeads.length === 0) {
      nodes.set(coordinate, { coordinate, resolved: false, reason: "no eligible current head", event: null, candidates: revisions.filter((event) => !previous.has(event.id)) });
      continue;
    }
    const newest = Math.max(...eligibleHeads.map((event) => event.created_at));
    const latest = eligibleHeads.filter((event) => event.created_at === newest);
    if (latest.length !== 1) {
      nodes.set(coordinate, { coordinate, resolved: false, reason: "equal-timestamp current-head fork", event: null, candidates: latest });
      continue;
    }
    nodes.set(coordinate, { coordinate, resolved: true, reason: null, event: latest[0], candidates: latest });
  }
  return nodes;
};

export const reachableCoordinates = (nodes, root = ROOT_COORDINATE) => {
  const reachable = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes.values()) {
      if (!node.resolved || reachable.has(node.coordinate)) continue;
      if (parentCoordinates(node.event).some((parent) => reachable.has(parent))) {
        reachable.add(node.coordinate);
        changed = true;
      }
    }
  }
  return reachable;
};

const assertNoReachableCycle = (nodes, reachable) => {
  const visited = new Set();
  const active = new Set();
  const visit = (coordinate) => {
    if (active.has(coordinate)) throw new Error(`problem DAG cycle reaches ${coordinate}`);
    if (visited.has(coordinate)) return;
    active.add(coordinate);
    const node = nodes.get(coordinate);
    if (node?.resolved) {
      for (const parent of parentCoordinates(node.event)) if (reachable.has(parent)) visit(parent);
    }
    active.delete(coordinate);
    visited.add(coordinate);
  };
  for (const coordinate of reachable) visit(coordinate);
};

export const effectiveClaim = (actions, node, now = Math.floor(Date.now() / 1000)) => {
  if (!node?.resolved) return null;
  const valid = uniqueEvents(actions).filter((event) =>
    event.kind === 1111
    && tagsNamed(event, "claim").some((tag) => tag.length === 1)
    && tagsNamed(event, "a").some((tag) => tag[1] === node.coordinate)
    && tagsNamed(event, "e").some((tag) => tag[1] === node.event.id)
    && event.created_at >= node.event.created_at
    && event.created_at + CLAIM_SECONDS > now);
  valid.sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
  return valid[0] ?? null;
};

const childNodes = (nodes, coordinate) => [...nodes.values()].filter((node) =>
  (node.resolved ? [node.event] : node.candidates).some((event) => parentCoordinates(event).includes(coordinate)));

export const actionableNodes = (nodes, actions, now = Math.floor(Date.now() / 1000)) => {
  const reachable = reachableCoordinates(nodes);
  assertNoReachableCycle(nodes, reachable);
  return [...nodes.values()].filter((node) =>
    node.resolved
    && node.coordinate !== ROOT_COORDINATE
    && reachable.has(node.coordinate)
    && (tagValue(node.event, "status") ?? "open") === "open"
    && childNodes(nodes, node.coordinate).length === 0
    && !effectiveClaim(actions, node, now));
};

const authorOutboxQuery = async (kind, authors, operation) => {
  const output = [];
  for (let offset = 0; offset < authors.length; offset += 100) {
    const group = authors.slice(offset, offset + 100);
    const authorArgs = group.flatMap((author) => ["-a", author]);
    output.push(...await query(["-k", String(kind), ...authorArgs, "-l", "10000", "--outbox", "--outbox-relays-per-pubkey", "5", ...BOOTSTRAP_RELAYS], operation));
  }
  return output;
};

const loadDag = async () => {
  const discovered = await query(["-k", "31971", "-t", `A=${ROOT_COORDINATE}`, "-l", "10000", ...BOOTSTRAP_RELAYS], "problem discovery");
  const authors = [...new Set(discovered.map((event) => event.pubkey).filter(Boolean))];
  const outboxes = authors.length ? await authorOutboxQuery(31971, authors, "problem author outboxes") : [];
  const nodes = selectCurrentNodes([...discovered, ...outboxes]);
  const root = nodes.get(ROOT_COORDINATE);
  if (!root) throw new Error(`root problem ${ROOT_ID} not found`);
  if (!root.resolved) throw new Error(`root problem current revision unresolved: ${root.reason}`);
  const reachable = reachableCoordinates(nodes);
  assertNoReachableCycle(nodes, reachable);
  return { nodes, reachable };
};

const loadActions = async (coordinates) => {
  if (coordinates.length === 0) return [];
  const filter = JSON.stringify({ kinds: [1111], "#A": coordinates });
  const discovered = await query(["-l", "10000", ...BOOTSTRAP_RELAYS], "workflow discovery", filter);
  const authors = [...new Set(discovered.map((event) => event.pubkey).filter(Boolean))];
  const outboxes = authors.length ? await authorOutboxQuery(1111, authors, "workflow author outboxes") : [];
  return uniqueEvents([...discovered, ...outboxes]);
};

const normalizeInputId = (input) => input.toLowerCase().replace("...", "…");
export const resolveNode = (nodes, input) => {
  const normalized = normalizeInputId(input);
  let matches;
  if (/^[0-9a-f]{64}$/.test(normalized)) {
    matches = [...nodes.values()].filter((node) => node.coordinate.endsWith(`:${normalized}`));
  } else {
    const [prefix, suffix = ""] = normalized.split("…");
    if (!/^[0-9a-f]{4,63}$/.test(prefix) || (suffix && !/^[0-9a-f]{4,63}$/.test(suffix))) {
      throw new Error("problem ID must be 64 hex characters, a hex prefix, or prefix…suffix");
    }
    matches = [...nodes.values()].filter((node) => {
      const id = node.coordinate.split(":")[2];
      return id.startsWith(prefix) && id.endsWith(suffix);
    });
  }
  if (matches.length !== 1) throw new Error(`problem ID matched ${matches.length} problems`);
  return matches[0];
};

const compactId = (id) => `${id.slice(0, 8)}…${id.slice(-6)}`;
const nodeSummary = (node) => ({
  problemId: node.coordinate.split(":")[2],
  coordinate: node.coordinate,
  resolved: node.resolved,
  reason: node.reason,
  eventId: node.event?.id ?? null,
  title: node.event ? (tagValue(node.event, "title") ?? "Untitled problem") : null,
  status: node.event ? (tagValue(node.event, "status") ?? "open") : null,
  description: node.event?.content ?? null,
});

const printNode = (node) => {
  const value = nodeSummary(node);
  if (!value.resolved) {
    console.log(`- [unresolved] ${value.coordinate}\n  ${value.reason}`);
    return;
  }
  console.log(`- [${value.status}] ${value.title}\n  ${compactId(value.problemId)}\n  Full ID: ${value.problemId}\n  Event: ${value.eventId}\n  ${value.description.replace(/\n+/g, " ")}`);
};

const inspect = async (id) => {
  const { nodes, reachable } = await loadDag();
  const node = resolveNode(nodes, id);
  if (!reachable.has(node.coordinate)) throw new Error("problem is not reachable from the Nostrocket root");
  const actions = node.resolved ? await loadActions([node.coordinate]) : [];
  const children = node.resolved ? childNodes(nodes, node.coordinate) : [];
  const claim = effectiveClaim(actions, node);
  console.log(JSON.stringify({ ...nodeSummary(node), children: children.map(nodeSummary), effectiveClaim: claim && { eventId: claim.id, claimant: claim.pubkey, expiresAt: claim.created_at + CLAIM_SECONDS } }, null, 2));
};

const listChildren = async (id) => {
  const { nodes, reachable } = await loadDag();
  const node = resolveNode(nodes, id);
  if (!node.resolved) throw new Error(`problem current revision unresolved: ${node.reason}`);
  if (!reachable.has(node.coordinate)) throw new Error("problem is not reachable from the Nostrocket root");
  const children = childNodes(nodes, node.coordinate).sort((a, b) => (tagValue(a.event, "title") ?? "").localeCompare(tagValue(b.event, "title") ?? ""));
  console.log(`Found ${children.length} direct children of ${node.coordinate.split(":")[2]}:`);
  children.forEach(printNode);
};

const listActionable = async () => {
  const { nodes, reachable } = await loadDag();
  const coordinates = [...reachable].filter((coordinate) => coordinate !== ROOT_COORDINATE);
  const actions = await loadActions(coordinates);
  const available = actionableNodes(nodes, actions).sort((a, b) => (tagValue(a.event, "title") ?? "").localeCompare(tagValue(b.event, "title") ?? ""));
  console.log(`Found ${available.length} actionable problems under ${ROOT_ID}:`);
  available.forEach(printNode);
};

const importWorkspacePackage = async (name) => {
  const requireFromWorkspace = createRequire(path.join(workspaceDirectory, "packages", "nostr-engine", "package.json"));
  const resolved = requireFromWorkspace.resolve(name);
  return import(pathToFileURL(resolved).href);
};

const signerRuntime = async () => {
  const [{ EventStore }, { verifyEvent }, { RelayPool }, { NostrConnectSigner }] = await Promise.all([
    importWorkspacePackage("applesauce-core"),
    importWorkspacePackage("applesauce-core/helpers/event"),
    importWorkspacePackage("applesauce-relay"),
    importWorkspacePackage("applesauce-signers"),
  ]);
  const eventStore = new EventStore();
  const pool = new RelayPool();
  return { eventStore, pool, verifyEvent, NostrConnectSigner };
};

const readStdin = async () => {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
};

const connect = async () => {
  const bunkerUri = await readStdin();
  if (!bunkerUri.startsWith("bunker://")) throw new Error("Notary did not provide a valid bunker URI");
  const { pool, NostrConnectSigner } = await signerRuntime();
  let signer;
  try {
    signer = await NostrConnectSigner.fromBunkerURI(bunkerUri, {
      pool,
      permissions: NostrConnectSigner.buildSigningPermissions([1111]),
    });
    const pubkey = await signer.getPublicKey();
    const encoded = signer.getNbunksec();
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await chmod(sessionDirectory, 0o700);
    const temporary = `${sessionPath}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${encoded}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, sessionPath);
    } catch (error) {
      await unlink(temporary).catch((cleanupError) => {
        if (cleanupError?.code !== "ENOENT") console.error(`Failed to remove temporary NIP-46 session ${temporary}:`, cleanupError);
      });
      throw error;
    }
    await chmod(sessionPath, 0o600);
    console.log(`Connected Notary signer ${pubkey}`);
  } finally {
    if (signer) await signer.close();
    pool.close();
  }
};

const relaySelections = async (pubkey) => {
  const lists = await query(["-k", "10002", "-a", pubkey, "-l", "50", ...BOOTSTRAP_RELAYS], "actor relay-list lookup");
  const current = uniqueEvents(lists).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  const tags = current?.tags?.filter((tag) => tag[0] === "r" && tag[1]) ?? [];
  const write = tags.filter((tag) => tag[2] !== "read").map((tag) => tag[1]);
  const read = tags.filter((tag) => tag[2] !== "write").map((tag) => tag[1]);
  return {
    write: [...new Set(write.length ? write : BOOTSTRAP_RELAYS)],
    read: [...new Set(read.length ? read : BOOTSTRAP_RELAYS)],
  };
};

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const signAndPublish = async (draft) => {
  try {
    await access(sessionPath, fsConstants.R_OK);
  } catch (error) {
    throw new Error(`Notary is not connected; run 'bash scripts/nostrocket.sh connect' first (${error instanceof Error ? error.code ?? error.message : String(error)})`);
  }
  const sessionMetadata = await lstat(sessionPath);
  if (!sessionMetadata.isFile() || sessionMetadata.isSymbolicLink()) throw new Error("NIP-46 session path is not a regular file");
  if ((sessionMetadata.mode & 0o077) !== 0) throw new Error("NIP-46 session file permissions must be 0600");
  const encoded = (await readFile(sessionPath, "utf8")).trim();
  const { eventStore, pool, verifyEvent, NostrConnectSigner } = await signerRuntime();
  let signer;
  try {
    signer = await NostrConnectSigner.fromNbunksec(encoded, {
      pool,
      permissions: NostrConnectSigner.buildSigningPermissions([1111]),
    });
    const expectedPubkey = await signer.getPublicKey();
    const signed = await signer.signEvent(draft);
    if (signed.pubkey !== expectedPubkey) throw new Error("Notary signed with an unexpected public key");
    for (const field of ["kind", "created_at", "content", "tags"]) {
      if (!sameJson(signed[field], draft[field])) throw new Error(`Notary changed workflow event ${field}`);
    }
    if (!verifyEvent(signed)) throw new Error("Notary returned an invalid event ID or signature");
    eventStore.add(signed);
    const recipients = [...new Set(draft.tags.filter((tag) => tag[0] === "p" || tag[0] === "P").map((tag) => tag[1]).filter((pubkey) => pubkey && pubkey !== expectedPubkey))];
    const [actorRelays, ...recipientRelays] = await Promise.all([relaySelections(expectedPubkey), ...recipients.map(relaySelections)]);
    const relays = [...new Set([...actorRelays.write, ...recipientRelays.flatMap((selection) => selection.read)])];
    const responses = await pool.publish(relays, signed, { timeout: 15_000, retries: 1 });
    const accepted = responses.filter((response) => response.ok).map((response) => response.from);
    if (accepted.length === 0) {
      const reasons = responses.map((response) => `${response.from}: ${response.message ?? "rejected"}`).join("; ");
      throw new Error(`no relay accepted event ${signed.id}${reasons ? ` (${reasons})` : ""}`);
    }
    return { signed, accepted };
  } finally {
    if (signer) await signer.close();
    pool.close();
  }
};

export const workflowDraft = (node, action, content, now = Math.floor(Date.now() / 1000)) => {
  const event = node.event;
  const coordinate = node.coordinate;
  const owner = coordinate.split(":")[1];
  const relay = event.tags?.find((tag) => tag[0] === "a" && tag[3] === "origin")?.[2] ?? "";
  return {
    kind: 1111,
    created_at: Math.max(now, event.created_at),
    content,
    tags: [
      ["A", coordinate, relay],
      ["K", "31971"],
      ["P", owner, relay],
      ["a", coordinate, relay],
      ["e", event.id, relay, event.pubkey],
      ["k", "31971"],
      ["p", event.pubkey, relay],
      [action],
    ],
  };
};

const mutate = async (action, id, proof) => {
  const { nodes, reachable } = await loadDag();
  const node = resolveNode(nodes, id);
  if (!node.resolved) throw new Error(`problem current revision unresolved: ${node.reason}`);
  if (!reachable.has(node.coordinate)) throw new Error("problem is not reachable from the Nostrocket root");
  const actions = await loadActions([node.coordinate]);
  const status = tagValue(node.event, "status") ?? "open";
  if (action === "claim") {
    if (status !== "open") throw new Error(`problem status is ${status}, not open`);
    if (childNodes(nodes, node.coordinate).length) throw new Error("problem has current children and is not actionable");
    const claim = effectiveClaim(actions, node);
    if (claim) throw new Error(`problem has an effective claim by ${claim.pubkey} until ${claim.created_at + CLAIM_SECONDS}`);
  } else if (!new Set(["open", "claimed"]).has(status)) {
    throw new Error(`problem status ${status} cannot transition to patched`);
  }
  const content = action === "claim" ? "Claiming this problem." : proof;
  const { signed, accepted } = await signAndPublish(workflowDraft(node, action, content));
  console.log(`Published ${action === "claim" ? "claim" : "patch"} ${signed.id}`);
  console.log(`Accepted by: ${accepted.join(", ")}`);
};

export const main = async (argv) => {
  const [command, ...args] = argv;
  if (command === "actionable" && args.length === 0) return listActionable();
  if (command === "inspect" && args.length === 1) return inspect(args[0]);
  if (command === "children" && args.length === 1) return listChildren(args[0]);
  if (command === "claim" && args.length === 1) return mutate("claim", args[0]);
  if (command === "patch" && args.length === 3 && args[1] === "--proof") {
    let proof;
    try { proof = new URL(args[2]); }
    catch (error) { throw new Error(`patch proof is not a valid URL: ${error instanceof Error ? error.message : String(error)}`); }
    if (proof.protocol !== "https:") throw new Error("patch proof must use https://");
    return mutate("patched", args[0], proof.href);
  }
  if (command === "connect" && args.length === 0) return connect();
  usage();
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`error: nostrocket operation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
