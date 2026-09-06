import { expect, test } from "vitest";
import {
  ROOT_COORDINATE,
  ROOT_ID,
  ROOT_OWNER,
  NOTARY_INSTALLER_SHA256,
  NOTARY_INSTALLER_URL,
  actionableNodes,
  assertNotaryPlatform,
  claimsForPubkey,
  effectiveClaim,
  installerSha256,
  notaryInstallLocations,
  notaryStatusMessage,
  pairedSignerPublicKey,
  resolveNode,
  requireNotarySessionStatus,
  selectCurrentNodes,
  verifyNotaryInstaller,
  workflowDraft,
} from "../scripts/nostrocket.mjs";

const hex = (character) => character.repeat(64);
const event = ({ id, problemId, owner = ROOT_OWNER, pubkey = owner, createdAt, status = "open", title = problemId, parents = [], previous = [], extraTags = [] }) => ({
  id,
  pubkey,
  created_at: createdAt,
  kind: 31971,
  content: `${title} body`,
  tags: [
    ["d", problemId],
    ["title", title],
    ["status", status],
    ["a", `31971:${owner}:${problemId}`, "wss://problems.example", "origin"],
    ["A", ROOT_COORDINATE, "wss://problems.example"],
    ...parents.map((parent) => ["a", parent, "wss://problems.example"]),
    ...previous.map((prior) => ["e", prior, "wss://problems.example", "previous", pubkey]),
    ...extraTags,
  ],
});

const claim = ({ id, claimant, coordinate, revisionId, createdAt }) => ({
  id,
  pubkey: claimant,
  created_at: createdAt,
  kind: 1111,
  content: "Claiming this problem.",
  tags: [["A", coordinate], ["a", coordinate], ["e", revisionId], ["claim"]],
});

const root = event({ id: hex("0"), problemId: ROOT_ID, createdAt: 1, title: "Root" });
const parentId = hex("a");
const leafId = hex("b");
const closedId = hex("c");
const forkId = hex("d");
const parent = event({ id: hex("1"), problemId: parentId, createdAt: 2, title: "Parent", parents: [ROOT_COORDINATE] });
const oldLeaf = event({ id: hex("2"), problemId: leafId, createdAt: 3, title: "Old leaf", parents: [`31971:${ROOT_OWNER}:${parentId}`] });
const leaf = event({ id: hex("3"), problemId: leafId, createdAt: 4, title: "Leaf", parents: [`31971:${ROOT_OWNER}:${parentId}`], previous: [oldLeaf.id] });
const closed = event({ id: hex("4"), problemId: closedId, createdAt: 5, status: "closed", title: "Closed", parents: [ROOT_COORDINATE] });
const forkA = event({ id: hex("5"), problemId: forkId, createdAt: 6, title: "Fork A", parents: [ROOT_COORDINATE] });
const forkB = event({ id: hex("6"), problemId: forkId, createdAt: 6, title: "Fork B", parents: [ROOT_COORDINATE] });

test("selects revisions and leaves equal-time forks unresolved", () => {
  const nodes = selectCurrentNodes([root, parent, oldLeaf, leaf, closed, forkA, forkB]);
  expect(nodes.get(`31971:${ROOT_OWNER}:${leafId}`).event.id).toBe(leaf.id);
  expect(nodes.get(`31971:${ROOT_OWNER}:${forkId}`).resolved).toBe(false);
  expect(nodes.get(`31971:${ROOT_OWNER}:${forkId}`).reason).toMatch(/fork/);
});

test("actionable means reachable unclaimed open selected leaf", () => {
  const nodes = selectCurrentNodes([root, parent, oldLeaf, leaf, closed, forkA, forkB]);
  expect(actionableNodes(nodes, [], 100).map((node) => node.event.id)).toEqual([leaf.id]);

  const claim = {
    id: hex("7"), pubkey: hex("e"), created_at: 10, kind: 1111, content: "claim",
    tags: [["A", `31971:${ROOT_OWNER}:${leafId}`], ["a", `31971:${ROOT_OWNER}:${leafId}`], ["e", leaf.id], ["claim"]],
  };
  expect(actionableNodes(nodes, [claim], 100)).toEqual([]);
  expect(effectiveClaim([claim], nodes.get(`31971:${ROOT_OWNER}:${leafId}`), 100).id).toBe(claim.id);
  expect(effectiveClaim([claim], nodes.get(`31971:${ROOT_OWNER}:${leafId}`), 10 + 86_400)).toBeNull();
});

test("lists own winning claim after considering every competitor", () => {
  const claimant = hex("e");
  const competitor = hex("f");
  const coordinate = `31971:${ROOT_OWNER}:${leafId}`;
  const own = claim({ id: hex("8"), claimant, coordinate, revisionId: leaf.id, createdAt: 10 });
  const later = claim({ id: hex("7"), claimant: competitor, coordinate, revisionId: leaf.id, createdAt: 11 });
  const nodes = selectCurrentNodes([root, parent, oldLeaf, leaf]);
  expect(claimsForPubkey(nodes, [own, later], claimant, 100)[0]).toMatchObject({
    eventId: own.id,
    state: "active",
    winnerEventId: own.id,
  });

  const earlier = claim({ id: hex("9"), claimant: competitor, coordinate, revisionId: leaf.id, createdAt: 9 });
  expect(claimsForPubkey(nodes, [own, later, earlier], claimant, 100)[0]).toMatchObject({
    state: "outcompeted",
    winnerEventId: earlier.id,
  });
});

test("equal-time competing claims use ascending event ID", () => {
  const claimant = hex("e");
  const coordinate = `31971:${ROOT_OWNER}:${leafId}`;
  const own = claim({ id: hex("b"), claimant, coordinate, revisionId: leaf.id, createdAt: 10 });
  const competitor = claim({ id: hex("a"), claimant: hex("f"), coordinate, revisionId: leaf.id, createdAt: 10 });
  const nodes = selectCurrentNodes([root, parent, oldLeaf, leaf]);
  expect(claimsForPubkey(nodes, [own, competitor], claimant, 100)[0]).toMatchObject({
    state: "outcompeted",
    winnerEventId: competitor.id,
  });
});

test("claims expire after 24 hours", () => {
  const claimant = hex("e");
  const coordinate = `31971:${ROOT_OWNER}:${leafId}`;
  const own = claim({ id: hex("8"), claimant, coordinate, revisionId: leaf.id, createdAt: 10 });
  const nodes = selectCurrentNodes([root, parent, oldLeaf, leaf]);
  expect(claimsForPubkey(nodes, [own], claimant, 10 + 86_400)[0].state).toBe("expired");
});

test("open supersession preserves a claim but a status change supersedes it", () => {
  const claimant = hex("e");
  const coordinate = `31971:${ROOT_OWNER}:${leafId}`;
  const own = claim({ id: hex("8"), claimant, coordinate, revisionId: oldLeaf.id, createdAt: 3 });
  const openNodes = selectCurrentNodes([root, parent, oldLeaf, leaf]);
  expect(claimsForPubkey(openNodes, [own], claimant, 100)[0].state).toBe("active");

  const closedRevision = event({ id: hex("9"), problemId: leafId, createdAt: 5, status: "closed", parents: [`31971:${ROOT_OWNER}:${parentId}`], previous: [leaf.id] });
  const closedNodes = selectCurrentNodes([root, parent, oldLeaf, leaf, closedRevision]);
  expect(claimsForPubkey(closedNodes, [own], claimant, 100)[0].state).toBe("superseded");
});

test("selected claimed revision acknowledges its recorded claimant", () => {
  const claimant = hex("e");
  const coordinate = `31971:${ROOT_OWNER}:${leafId}`;
  const own = claim({ id: hex("8"), claimant, coordinate, revisionId: leaf.id, createdAt: 5 });
  const acknowledged = event({
    id: hex("9"), problemId: leafId, createdAt: 6, status: "claimed",
    parents: [`31971:${ROOT_OWNER}:${parentId}`], previous: [leaf.id],
    extraTags: [["claim", own.id, claimant]],
  });
  const nodes = selectCurrentNodes([root, parent, oldLeaf, leaf, acknowledged]);
  expect(claimsForPubkey(nodes, [own], claimant, 100)[0].state).toBe("acknowledged");

  const prunedHistoryNodes = selectCurrentNodes([root, parent, acknowledged]);
  expect(claimsForPubkey(prunedHistoryNodes, [own], claimant, 100)[0].state).toBe("acknowledged");
});

test("rfm claim remains a pending request", () => {
  const claimant = hex("e");
  const requestId = hex("7");
  const request = event({ id: hex("8"), problemId: requestId, createdAt: 7, status: "rfm", parents: [ROOT_COORDINATE] });
  const coordinate = `31971:${ROOT_OWNER}:${requestId}`;
  const own = claim({ id: hex("9"), claimant, coordinate, revisionId: request.id, createdAt: 8 });
  const nodes = selectCurrentNodes([root, request]);
  expect(claimsForPubkey(nodes, [own], claimant, 100)[0].state).toBe("pending");
});

test("claims disclose unresolved and unreachable problem state", () => {
  const claimant = hex("e");
  const forkCoordinate = `31971:${ROOT_OWNER}:${forkId}`;
  const unresolvedClaim = claim({ id: hex("7"), claimant, coordinate: forkCoordinate, revisionId: forkA.id, createdAt: 7 });
  const orphanId = hex("8");
  const orphan = event({ id: hex("9"), problemId: orphanId, createdAt: 8, parents: [`31971:${ROOT_OWNER}:${hex("f")}`] });
  const orphanCoordinate = `31971:${ROOT_OWNER}:${orphanId}`;
  const unreachableClaim = claim({ id: hex("a"), claimant, coordinate: orphanCoordinate, revisionId: orphan.id, createdAt: 9 });
  const nodes = selectCurrentNodes([root, forkA, forkB, orphan]);
  expect(claimsForPubkey(nodes, [unresolvedClaim, unreachableClaim], claimant, 100).map(({ state }) => state).sort()).toEqual(["unreachable", "unresolved"]);
});

test("paired signer lookup only requests getPublicKey", async () => {
  const calls = [];
  const signer = {
    getPublicKey: async () => { calls.push("getPublicKey"); return hex("e"); },
    close: async () => { calls.push("signer.close"); },
    signEvent: async () => { throw new Error("must not sign"); },
  };
  const NostrConnectSigner = {
    fromNbunksec: async (encoded, options) => {
      calls.push(["fromNbunksec", encoded, options]);
      return signer;
    },
  };
  const pool = {
    close: () => { calls.push("pool.close"); },
    publish: async () => { throw new Error("must not publish"); },
  };
  await expect(pairedSignerPublicKey("private-session", { pool, NostrConnectSigner })).resolves.toBe(hex("e"));
  expect(calls).toEqual([
    ["fromNbunksec", "private-session", { pool }],
    "getPublicKey",
    "signer.close",
    "pool.close",
  ]);
});

test("an unresolved child keeps its parent structural", () => {
  const structuralId = hex("8");
  const childForkId = hex("9");
  const structural = event({ id: hex("a"), problemId: structuralId, createdAt: 8, title: "Structural", parents: [ROOT_COORDINATE] });
  const childForkA = event({ id: hex("b"), problemId: childForkId, createdAt: 9, title: "Child fork A", parents: [`31971:${ROOT_OWNER}:${structuralId}`] });
  const childForkB = event({ id: hex("c"), problemId: childForkId, createdAt: 9, title: "Child fork B", parents: [`31971:${ROOT_OWNER}:${structuralId}`] });
  const nodes = selectCurrentNodes([root, structural, childForkA, childForkB]);
  expect(actionableNodes(nodes, [], 100)).toEqual([]);
});

test("abbreviated IDs resolve only when unique", () => {
  const nodes = selectCurrentNodes([root, parent, leaf]);
  expect(resolveNode(nodes, `${leafId.slice(0, 8)}…${leafId.slice(-6)}`).event.id).toBe(leaf.id);
  expect(() => resolveNode(nodes, "ffff")).toThrow(/matched 0/);
});

test("workflow drafts match the NIP-1971 contributor tag shape", () => {
  const node = selectCurrentNodes([leaf]).get(`31971:${ROOT_OWNER}:${leafId}`);
  const draft = workflowDraft(node, "patched", "https://example.com/proof", 20);
  expect(draft.kind).toBe(1111);
  expect(draft.created_at).toBe(20);
  expect(draft.content).toBe("https://example.com/proof");
  expect(draft.tags).toEqual([
    ["A", node.coordinate, "wss://problems.example"],
    ["K", "31971"],
    ["P", ROOT_OWNER, "wss://problems.example"],
    ["a", node.coordinate, "wss://problems.example"],
    ["e", leaf.id, "wss://problems.example", ROOT_OWNER],
    ["k", "31971"],
    ["p", ROOT_OWNER, "wss://problems.example"],
    ["patched"],
  ]);
});

test("Notary installation stays explicit and platform-bound", () => {
  expect(notaryInstallLocations("/Users/tester")).toEqual([
    "/Applications/Notary.app",
    "/Users/tester/Applications/Notary.app",
  ]);
  expect(() => assertNotaryPlatform("darwin", "arm64")).not.toThrow();
  expect(() => assertNotaryPlatform("linux", "arm64")).toThrow(/macOS only/);
  expect(() => assertNotaryPlatform("darwin", "x64")).toThrow(/Apple Silicon only/);
  expect(NOTARY_INSTALLER_URL).toMatch(/\/157e0aae107ca4d3f25ed6f2b6885882b12d70eb\//);
});

test("Notary status gives the next safe setup step", () => {
  expect(notaryStatusMessage({ installed: false, connected: false })).toMatch(/explicitly request.*install-notary/);
  expect(notaryStatusMessage({ installed: true, connected: false })).toMatch(/local terminal/);
  expect(notaryStatusMessage({ installed: true, connected: true })).toBe("Notary setup: ready");
  expect(() => requireNotarySessionStatus({ installed: false, connected: false })).toThrow(/explicitly request.*install-notary/);
  expect(() => requireNotarySessionStatus({ installed: true, connected: false })).toThrow(/local terminal/);
  expect(() => requireNotarySessionStatus({ installed: true, connected: true })).not.toThrow();
});

test("Notary installer content must match reviewed checksum", () => {
  expect(installerSha256(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(NOTARY_INSTALLER_SHA256).toHaveLength(64);
  expect(() => verifyNotaryInstaller(Buffer.from("changed installer"))).toThrow(/checksum mismatch/);
});
