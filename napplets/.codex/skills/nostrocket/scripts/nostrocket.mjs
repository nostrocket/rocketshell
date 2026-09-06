#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
export const NOTARY_INSTALLER_URL = "https://raw.githubusercontent.com/zig-nostr/notary/157e0aae107ca4d3f25ed6f2b6885882b12d70eb/scripts/install-macos.sh";
export const NOTARY_INSTALLER_SHA256 = "30a2216c7986905aee4f5c49a4904034217687ad765d6b67fa32d15aba2c77d5";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(scriptDirectory, "../../../../..");
const sessionDirectory = path.join(homedir(), ".config", "nostrocket");
const sessionPath = path.join(sessionDirectory, "notary-nip46.nbunksec");

const usage = () => {
  console.error("usage: nostrocket.sh actionable | claims [--format human|json] | inspect <problem-id> | children <problem-id> | claim <problem-id> | patch <problem-id> --proof <https-url> | notary-status | install-notary | connect");
  process.exitCode = 2;
};

export const notaryInstallLocations = (userHome = homedir()) => [
  "/Applications/Notary.app",
  path.join(userHome, "Applications", "Notary.app"),
];

const findInstalledNotary = async () => {
  for (const candidate of notaryInstallLocations()) {
    try {
      const metadata = await lstat(candidate);
      if (metadata.isDirectory()) return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`could not inspect ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
};

export const notaryStatusMessage = ({ installed, connected }) => {
  if (connected) return "Notary setup: ready";
  if (installed) return "Notary setup: installed, not connected; copy the bunker URI from Notary and run 'bash scripts/nostrocket.sh connect' in your local terminal";
  return "Notary setup: not installed; explicitly request '$nostrocket install-notary' before connecting";
};

const hasNotarySession = async () => {
  try {
    const metadata = await lstat(sessionPath);
    return metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error(`could not inspect Notary session: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const notaryStatus = async () => {
  const [installed, connected] = await Promise.all([
    findInstalledNotary(),
    hasNotarySession(),
  ]);
  console.log(notaryStatusMessage({ installed: Boolean(installed), connected }));
};

const requireNotarySession = async () => {
  if (await hasNotarySession()) return;
  const installed = await findInstalledNotary();
  requireNotarySessionStatus({ installed: Boolean(installed), connected: false });
};

export const requireNotarySessionStatus = ({ installed, connected }) => {
  if (connected) return;
  throw new Error(notaryStatusMessage({ installed, connected }));
};

export const assertNotaryPlatform = (platform = process.platform, architecture = process.arch) => {
  if (platform !== "darwin") throw new Error("Notary installer supports macOS only");
  if (architecture !== "arm64") throw new Error("Notary installer supports Apple Silicon only; build from source on Intel Macs");
};

export const installerSha256 = (contents) => createHash("sha256").update(contents).digest("hex");

export const verifyNotaryInstaller = (contents) => {
  const actual = installerSha256(contents);
  if (actual !== NOTARY_INSTALLER_SHA256) throw new Error(`official Notary installer checksum mismatch: expected ${NOTARY_INSTALLER_SHA256}, got ${actual}`);
};

const runInstaller = (installerPath) => new Promise((resolve, reject) => {
  const child = spawn("/bin/bash", [installerPath], { stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (error) => reject(new Error(`Notary installer could not start: ${error.message}`)));
  child.on("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`Notary installer exited ${code}`));
  });
});

const installNotary = async () => {
  const existing = await findInstalledNotary();
  if (existing) {
    console.log(`Notary already installed at ${existing}`);
    return;
  }
  assertNotaryPlatform();
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "nostrocket-notary-"));
  const installerPath = path.join(temporaryDirectory, "install-macos.sh");
  try {
    const response = await fetch(NOTARY_INSTALLER_URL);
    if (!response.ok) throw new Error(`official Notary installer download failed: HTTP ${response.status}`);
    const contents = Buffer.from(await response.arrayBuffer());
    verifyNotaryInstaller(contents);
    await writeFile(installerPath, contents, { mode: 0o700, flag: "wx" });
    console.log("Official Notary installer verified. Installing and opening Notary...");
    await runInstaller(installerPath);
    const installed = await findInstalledNotary();
    if (!installed) throw new Error("Notary installer completed but Notary.app was not found");
    console.log(`Notary installed at ${installed}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch((error) => {
      console.error(`Failed to remove temporary Notary installer directory ${temporaryDirectory}:`, error);
    });
  }
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
      nodes.set(coordinate, { coordinate, resolved: false, reason: "no eligible current head", event: null, candidates: revisions.filter((event) => !previous.has(event.id)), revisions });
      continue;
    }
    const newest = Math.max(...eligibleHeads.map((event) => event.created_at));
    const latest = eligibleHeads.filter((event) => event.created_at === newest);
    if (latest.length !== 1) {
      nodes.set(coordinate, { coordinate, resolved: false, reason: "equal-timestamp current-head fork", event: null, candidates: latest, revisions });
      continue;
    }
    nodes.set(coordinate, { coordinate, resolved: true, reason: null, event: latest[0], candidates: latest, revisions });
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

const parseClaimAction = (event) => {
  if (event?.kind !== 1111 || !/^[0-9a-f]{64}$/.test(event.id ?? "") || !/^[0-9a-f]{64}$/.test(event.pubkey ?? "")) return null;
  const scopes = tagsNamed(event, "A");
  const coordinates = tagsNamed(event, "a");
  const revisions = tagsNamed(event, "e");
  const markers = tagsNamed(event, "claim");
  const coordinate = scopes[0]?.[1];
  if (scopes.length !== 1 || coordinates.length !== 1 || revisions.length !== 1 || markers.length !== 1 || markers[0].length !== 1) return null;
  if (!/^31971:[0-9a-f]{64}:[0-9a-f]{64}$/.test(coordinate ?? "") || coordinates[0][1] !== coordinate) return null;
  if (!/^[0-9a-f]{64}$/.test(revisions[0][1] ?? "") || !Number.isInteger(event.created_at)) return null;
  return { event, coordinate, revisionId: revisions[0][1] };
};

const revisionMap = (node) => new Map((node?.revisions ?? []).map((event) => [event.id, event]));

const selectedRevisionPathContains = (node, targetId, requiredStatus) => {
  if (!node?.resolved) return false;
  const revisions = revisionMap(node);
  const pending = [node.event.id];
  const visited = new Set();
  while (pending.length) {
    const revisionId = pending.pop();
    if (visited.has(revisionId)) continue;
    visited.add(revisionId);
    const revision = revisions.get(revisionId);
    if (!revision || (requiredStatus !== undefined && (tagValue(revision, "status") ?? "open") !== requiredStatus)) continue;
    if (revisionId === targetId) return true;
    pending.push(...tagsNamed(revision, "e").filter((tag) => tag[3] === "previous").map((tag) => tag[1]));
  }
  return false;
};

const claimTarget = (claim, node) => {
  const target = revisionMap(node).get(claim.revisionId);
  if (!target || claim.event.created_at < target.created_at) return null;
  return target;
};

const activeClaimCandidates = (actions, node, now) => {
  if (!node?.resolved) return [];
  const status = tagValue(node.event, "status") ?? "open";
  if (status === "rfm") return [];
  return uniqueEvents(actions).map(parseClaimAction).filter((claim) => {
    if (!claim || claim.coordinate !== node.coordinate || claim.event.created_at + CLAIM_SECONDS <= now) return false;
    const target = claimTarget(claim, node);
    return target && (tagValue(target, "status") ?? "open") === status
      && selectedRevisionPathContains(node, claim.revisionId, status);
  });
};

export const effectiveClaim = (actions, node, now = Math.floor(Date.now() / 1000)) => {
  const valid = activeClaimCandidates(actions, node, now).map((claim) => claim.event);
  valid.sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
  return valid[0] ?? null;
};

const acknowledgedBySelectedRevision = (node, claim) => {
  if (!node?.resolved || (tagValue(node.event, "status") ?? "open") !== "claimed") return false;
  const acknowledgements = tagsNamed(node.event, "claim");
  return acknowledgements.length === 1
    && acknowledgements[0].length === 3
    && acknowledgements[0][1] === claim.event.id
    && acknowledgements[0][2] === claim.event.pubkey;
};

export const claimsForPubkey = (nodes, actions, pubkey, now = Math.floor(Date.now() / 1000)) => {
  const reachable = reachableCoordinates(nodes);
  const parsed = uniqueEvents(actions).map(parseClaimAction).filter(Boolean);
  const winners = new Map();
  for (const node of nodes.values()) {
    const candidates = activeClaimCandidates(actions, node, now)
      .sort((left, right) => left.event.created_at - right.event.created_at || left.event.id.localeCompare(right.event.id));
    if (candidates[0]) winners.set(node.coordinate, candidates[0]);
  }

  return parsed.filter((claim) => claim.event.pubkey === pubkey && nodes.has(claim.coordinate)).map((claim) => {
    const node = nodes.get(claim.coordinate);
    const target = claimTarget(claim, node);
    let state;
    if (!node.resolved) state = "unresolved";
    else if (!reachable.has(node.coordinate)) state = "unreachable";
    else if (claim.event.created_at + CLAIM_SECONDS <= now) state = "expired";
    else if (acknowledgedBySelectedRevision(node, claim)) state = "acknowledged";
    else if (!target || !selectedRevisionPathContains(node, claim.revisionId)) state = "superseded";
    else {
      const status = tagValue(node.event, "status") ?? "open";
      const targetStatus = tagValue(target, "status") ?? "open";
      if (!selectedRevisionPathContains(node, claim.revisionId, status) || targetStatus !== status) state = "superseded";
      else if (status === "rfm") state = "pending";
      else state = winners.get(node.coordinate)?.event.id === claim.event.id ? "active" : "outcompeted";
    }
    return {
      eventId: claim.event.id,
      problemId: claim.coordinate.split(":")[2],
      coordinate: claim.coordinate,
      title: node.resolved ? (tagValue(node.event, "title") ?? "Untitled problem") : null,
      state,
      problemStatus: node.resolved ? (tagValue(node.event, "status") ?? "open") : null,
      selectedRevisionId: node.event?.id ?? null,
      claimedAt: claim.event.created_at,
      expiresAt: claim.event.created_at + CLAIM_SECONDS,
      winnerEventId: winners.get(node.coordinate)?.event.id ?? null,
      winnerClaimant: winners.get(node.coordinate)?.event.pubkey ?? null,
    };
  }).sort((left, right) => right.claimedAt - left.claimedAt || left.eventId.localeCompare(right.eventId));
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

const printClaim = (claim) => {
  console.log(`- [${claim.state}] ${claim.title ?? "Unresolved problem"}`);
  console.log(`  ${compactId(claim.problemId)}`);
  console.log(`  Claim: ${claim.eventId}`);
  console.log(`  Expires: ${new Date(claim.expiresAt * 1000).toISOString()}`);
  if (claim.state === "outcompeted" && claim.winnerEventId) console.log(`  Winning claim: ${claim.winnerEventId}`);
};

const listMyClaims = async (format) => {
  const pubkey = await pairedNotaryPublicKey();
  const { nodes } = await loadDag();
  const actions = await loadActions([...nodes.keys()]);
  const claims = claimsForPubkey(nodes, actions, pubkey);
  if (format === "json") {
    console.log(JSON.stringify({ pubkey, claims }, null, 2));
    return;
  }
  console.log(`Found ${claims.length} claims for paired Notary signer:`);
  claims.forEach(printClaim);
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

const readNotarySession = async () => {
  await requireNotarySession();
  await access(sessionPath, fsConstants.R_OK);
  const metadata = await lstat(sessionPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("NIP-46 session path is not a regular file");
  if ((metadata.mode & 0o077) !== 0) throw new Error("NIP-46 session file permissions must be 0600");
  return (await readFile(sessionPath, "utf8")).trim();
};

export const pairedSignerPublicKey = async (encoded, { pool, NostrConnectSigner }) => {
  let signer;
  try {
    signer = await NostrConnectSigner.fromNbunksec(encoded, { pool });
    const pubkey = await signer.getPublicKey();
    if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("paired Notary returned an invalid public key");
    return pubkey;
  } finally {
    if (signer) await signer.close();
    pool.close();
  }
};

const pairedNotaryPublicKey = async () => pairedSignerPublicKey(await readNotarySession(), await signerRuntime());

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
  const encoded = await readNotarySession();
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
  await requireNotarySession();
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
  if (command === "claims" && args.length === 0) return listMyClaims("human");
  if (command === "claims" && args.length === 2 && args[0] === "--format" && new Set(["human", "json"]).has(args[1])) return listMyClaims(args[1]);
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
  if (command === "notary-status" && args.length === 0) return notaryStatus();
  if (command === "install-notary" && args.length === 0) return installNotary();
  if (command === "connect" && args.length === 0) return connect();
  usage();
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`error: nostrocket operation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
