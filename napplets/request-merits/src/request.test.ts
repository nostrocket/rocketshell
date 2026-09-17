import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/humblehorse-merit-request.json";
import { buildMeritRequest, publishMeritRequest, validateDraft, type MeritRequestDraft } from "./request";

const draft = (changes: Partial<MeritRequestDraft> = {}): MeritRequestDraft => ({
  rocket: "31108:d91191e30e00444b942c0e82cad470b32af171764c2275bee0bd99377efd4075:HumbleHorse",
  problem: "Fix sidebar labels", solution: "https://example.com/pull/1", solutionType: "url", sats: "33075", ...changes
});

describe("merit request", () => {
  it("preserves real HumbleHorse request as reference", () => {
    expect(fixture).toMatchObject({ id: "023ecb4582e73fccec1ab6d8c415f0a4eae97180ff4fc06153866900273e5894", kind: 1409, created_at: 1725946289 });
    expect(fixture.tags).toContainEqual(["merits", "33075"]);
  });
  it("builds URL proof request", () => {
    expect(buildMeritRequest(draft(), 123)).toEqual({ kind: 1409, created_at: 123, content: "", tags: [["problem", "text", "Fix sidebar labels"], ["solution", "url", "https://example.com/pull/1"], ["a", draft().rocket], ["merits", "33075"], ["sats", "33075"]] });
  });
  it("builds text proof request", () => {
    expect(buildMeritRequest(draft({ solutionType: "text", solution: "Shipped fix and regression coverage." }), 1).tags).toContainEqual(["solution", "text", "Shipped fix and regression coverage."]);
  });
  it("derives merits one-to-one from mandatory sats", () => {
    const tags = buildMeritRequest(draft({ solution: "", sats: "42" }), 1).tags;
    expect(tags).toContainEqual(["merits", "42"]);
    expect(tags).toContainEqual(["sats", "42"]);
    expect(tags.some(([name]) => name === "solution")).toBe(false);
  });
  it("rejects malformed required values and URL", () => {
    expect(validateDraft(draft({ rocket: "bad", problem: "", sats: "1.5", solution: "not a URL" }))).toHaveLength(4);
    expect(validateDraft(draft({ sats: "" }))).toContain("Work value must be a positive integer number of sats.");
  });
  it("publishes through author outbox", async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true, event: { id: "event-id", pubkey: "author" } });
    const template = buildMeritRequest(draft(), 1);
    await expect(publishMeritRequest(publish, template)).resolves.toEqual({ id: "event-id", pubkey: "author" });
    expect(publish).toHaveBeenCalledWith(template, { toOutbox: true });
  });
  it("publishes with explicit options when provided", async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true, event: { id: "event-id", pubkey: "author" } });
    const template = buildMeritRequest(draft(), 1);
    await expect(publishMeritRequest(publish, template, { relays: ["wss://relay.example"], toOutbox: false })).resolves.toEqual({ id: "event-id", pubkey: "author" });
    expect(publish).toHaveBeenCalledWith(template, { relays: ["wss://relay.example"], toOutbox: false });
  });
  it("surfaces publish rejection", async () => {
    await expect(publishMeritRequest(vi.fn().mockResolvedValue({ ok: false, error: "rejected" }), buildMeritRequest(draft(), 1))).rejects.toThrow("rejected");
  });
});
