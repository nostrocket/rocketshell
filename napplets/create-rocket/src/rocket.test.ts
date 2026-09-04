import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/nostrocket-ignition.json";
import { buildIgnitionTemplate, hasObservedRocketIdentifier, normalizeRocketIdentifier, publishIgnition, rocketIdentifier, validateDraft, type RocketDraft } from "./rocket";

const draft = (changes: Partial<RocketDraft> = {}): RocketDraft => ({ identifier: "MY_ROCKET", mission: "Coordinate independent builders.", problemCoordinate: "", problemRelay: "", repoCoordinate: "", repoRelay: "", ...changes });

describe("rocket ignition", () => {
  it("keeps exact signed NOSTROCKET ignition as protocol reference", () => {
    expect(fixture).toEqual({ kind: 31108, id: "acff2d209b97f458ba1539ee1b9fe802ca1f511fe1d912ce8fc9163fd2f140cd", pubkey: "d91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075", created_at: 1721634906, tags: [["d", "NOSTROCKET"], ["ruleset", "334000"], ["ignition", "this"], ["parent", "this"]], content: "", sig: "a8837515d5065d834549beeb5c848750311ef60832b5b314a32c3e7b312c59a1b6b3828f922e3d7bae9bf827dd5b225b1783c3fab4ca19aa889e4e0c1bfcd3b1" });
  });
  it("builds required ignition and mission tags without invented reference", () => {
    expect(buildIgnitionTemplate(draft(), 123)).toEqual({ kind: 31108, created_at: 123, content: "", tags: [["d", "MY_ROCKET"], ["ruleset", "334000"], ["ignition", "this"], ["parent", "this"], ["mission", "Coordinate independent builders."]] });
  });
  it("can reproduce the minimal NOSTROCKET ignition structure", () => {
    expect(buildIgnitionTemplate(draft({ identifier: "NOSTROCKET", mission: "" }), 1721634906)).toEqual({ kind: 31108, created_at: 1721634906, content: "", tags: [["d", "NOSTROCKET"], ["ruleset", "334000"], ["ignition", "this"], ["parent", "this"]] });
  });
  it("adds specified problem and repo shapes", () => {
    const pubkey = "a".repeat(64);
    const problemId = "b".repeat(64);
    expect(buildIgnitionTemplate(draft({ problemCoordinate: `31971:${pubkey}:${problemId}`, problemRelay: "wss://relay.example", repoCoordinate: `30617:${pubkey}:repo`, repoRelay: "wss://git.example" }), 1).tags.slice(-2)).toEqual([["problem", `31971:${pubkey}:${problemId}`, "wss://relay.example"], ["repo", `30617:${pubkey}:repo`, "wss://git.example"]]);
  });
  it("allows shell-derived references without an observed relay hint", () => {
    const pubkey = "a".repeat(64);
    const problemId = "b".repeat(64);
    expect(validateDraft(draft({ problemCoordinate: `31971:${pubkey}:${problemId}`, problemRelay: "" }))).toEqual([]);
  });
  it("rejects missing identifiers, long missions, coordinates, and relays", () => {
    expect(validateDraft(draft({ identifier: "", mission: "x".repeat(140), problemCoordinate: "31971:nope:x", problemRelay: "https://relay.example" })).length).toBeGreaterThanOrEqual(4);
  });
  it("extracts identifiers only from kind 31108 events", () => {
    expect(rocketIdentifier({ kind: 31108, tags: [["d", "  EXISTING_ROCKET  "]] })).toBe("EXISTING_ROCKET");
    expect(rocketIdentifier({ kind: 31108, tags: [["mission", "No identifier"]] })).toBeUndefined();
    expect(rocketIdentifier({ kind: 1, tags: [["d", "EXISTING_ROCKET"]] })).toBeUndefined();
  });
  it("detects identifiers case-insensitively without waiting for discovery", () => {
    const observed = new Set([normalizeRocketIdentifier("EXISTING_ROCKET")]);
    expect(hasObservedRocketIdentifier(" EXISTING_ROCKET ", observed)).toBe(true);
    expect(hasObservedRocketIdentifier("existing_rocket", observed)).toBe(true);
    expect(hasObservedRocketIdentifier("Existing_Rocket", observed)).toBe(true);
    expect(hasObservedRocketIdentifier("OTHER_ROCKET", observed)).toBe(false);
    expect(hasObservedRocketIdentifier("", observed)).toBe(false);
  });
  it("publishes to author outbox and returns event id", async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true, event: { id: "event-id" } });
    const template = buildIgnitionTemplate(draft(), 1);
    await expect(publishIgnition(publish, template)).resolves.toBe("event-id");
    expect(publish).toHaveBeenCalledWith(template, { toOutbox: true });
  });
  it("allows custom publish options such as explicit relays with toOutbox false", async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true, event: { id: "event-id-2" } });
    const template = buildIgnitionTemplate(draft(), 1);
    await expect(publishIgnition(publish, template, { relays: ["wss://relay.example"], toOutbox: false })).resolves.toBe("event-id-2");
    expect(publish).toHaveBeenCalledWith(template, { relays: ["wss://relay.example"], toOutbox: false });
  });
  it("surfaces structured publish failure", async () => {
    await expect(publishIgnition(vi.fn().mockResolvedValue({ ok: false, error: "rejected" }), buildIgnitionTemplate(draft(), 1))).rejects.toThrow("rejected");
  });
});
