import { describe, expect, it } from "vitest";
import type { NostrEvent, RelayEventResult } from "@napplet/sdk";
import { HEX_64, PROBLEM_COORDINATE, hasProblemChildren, isProblemIdPayload, selectCurrentHead } from "./problem";

const hex = (char: string) => char.repeat(64);

const result = (event: Partial<NostrEvent> & Pick<NostrEvent, "id" | "pubkey" | "tags">): RelayEventResult => ({
  event: { kind: 31971, created_at: 1, content: "body", sig: hex("f"), ...event },
  sidecar: { relayHints: ["wss://relay.example"] }
});

describe("shared problem primitives", () => {
  it("accepts exactly one lowercase 64-char problem id", () => {
    expect(isProblemIdPayload({ problemId: hex("a") })).toBe(true);
    expect(isProblemIdPayload({ problemId: hex("a"), extra: 1 })).toBe(false);
    expect(isProblemIdPayload({ problemId: "A".repeat(64) })).toBe(false);
    expect(isProblemIdPayload({ problemId: "short" })).toBe(false);
    expect(isProblemIdPayload(null)).toBe(false);
  });

  it("keeps the coordinate and key shapes in one place", () => {
    expect(HEX_64.test(hex("a"))).toBe(true);
    expect(HEX_64.test(hex("A"))).toBe(false);
    expect(PROBLEM_COORDINATE.test(`31971:${hex("a")}:${hex("b")}`)).toBe(true);
    expect(PROBLEM_COORDINATE.test(`31970:${hex("a")}:${hex("b")}`)).toBe(false);
  });

  it("rejects a forked current head", () => {
    const owner = hex("a");
    const problemId = hex("b");
    const tags = [["d", problemId], ["a", `31971:${owner}:${problemId}`, "", "origin"]];
    expect(selectCurrentHead([
      result({ id: hex("c"), pubkey: owner, tags }),
      result({ id: hex("d"), pubkey: owner, tags })
    ])).toBeUndefined();
  });

  it("counts only current direct child heads", () => {
    const owner = hex("a");
    const problemId = hex("b");
    const childId = hex("d");
    const childCoordinate = `31971:${hex("e")}:${childId}`;
    const child = (id: string, previous?: string, parent = `31971:${owner}:${problemId}`) => result({
      id, pubkey: hex("e"), tags: [["d", childId], ["a", childCoordinate, "", "origin"], ["a", parent],
        ...(previous ? [["e", previous, "", "previous"]] : [])]
    });
    const genesis = child(hex("1"));
    expect(hasProblemChildren(`31971:${owner}:${problemId}`, [genesis])).toBe(true);
    expect(hasProblemChildren(`31971:${owner}:${problemId}`, [genesis, child(hex("2"), hex("1"), `31971:${owner}:${hex("0")}`)])).toBe(false);
  });
});
