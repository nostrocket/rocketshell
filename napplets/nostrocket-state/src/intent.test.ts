import { describe, expect, it } from "vitest";
import { parseRocketViewPayload, ROCKET_VIEW_CONVENTION } from "./intent";

const coordinate = `31108:${"a".repeat(64)}:Routstr`;

describe("rocket view intent payload", () => {
  it("uses the stable queryless convention identity", () => {
    expect(ROCKET_VIEW_CONVENTION).toBe("napplet:rocket/open");
  });

  it("accepts a well-formed rocket coordinate", () => {
    expect(parseRocketViewPayload({ coordinate })).toEqual({ coordinate });
  });

  it("trims surrounding whitespace", () => {
    expect(parseRocketViewPayload({ coordinate: `  ${coordinate}  ` })).toEqual({ coordinate });
  });

  it("preserves rocket identifiers containing coordinate delimiters", () => {
    expect(parseRocketViewPayload({ coordinate: `31108:${"b".repeat(64)}:SATURN:OPS` })?.coordinate)
      .toBe(`31108:${"b".repeat(64)}:SATURN:OPS`);
  });

  it("rejects malformed payloads instead of guessing a rocket", () => {
    expect(parseRocketViewPayload(undefined)).toBeUndefined();
    expect(parseRocketViewPayload(null)).toBeUndefined();
    expect(parseRocketViewPayload("rocket")).toBeUndefined();
    expect(parseRocketViewPayload({})).toBeUndefined();
    expect(parseRocketViewPayload({ coordinate: "" })).toBeUndefined();
    expect(parseRocketViewPayload({ coordinate: "31971:not-a-rocket:x" })).toBeUndefined();
    expect(parseRocketViewPayload({ coordinate: "31108:short:Routstr" })).toBeUndefined();
  });
});
