import { describe, expect, it } from "vitest";
import { NOSTROCKET_AUTHOR, NOSTROCKET_COORDINATE, rocketsFromEvents } from "./rockets";
import type { NostrEvent } from "./state";

const event = (overrides: Partial<NostrEvent>): NostrEvent => ({ id: "1".repeat(64), pubkey: "2".repeat(64), created_at: 1, kind: 31108, tags: [["d", "SATURN"]], content: "", sig: "3".repeat(128), ...overrides });

describe("rocket discovery", () => {
  it("keeps newest event for every 31108 coordinate and NOSTROCKET first", () => {
    const rockets = rocketsFromEvents([
      event({ created_at: 1 }),
      event({ created_at: 2, id: "4".repeat(64) }),
      event({ pubkey: "5".repeat(64), tags: [["d", "MARS"]], id: "6".repeat(64) }),
      event({ pubkey: NOSTROCKET_AUTHOR, tags: [["d", "NOSTROCKET"]], id: "7".repeat(64) })
    ]);
    expect(rockets.map(({ coordinate }) => coordinate)).toEqual([NOSTROCKET_COORDINATE, `31108:${"5".repeat(64)}:MARS`, `31108:${"2".repeat(64)}:SATURN`]);
    expect(rockets[2].event?.created_at).toBe(2);
  });
  it("does not invent NOSTROCKET when it is absent from discovery", () => {
    expect(rocketsFromEvents([event({ tags: [["d", "SATURN"]] })])).toHaveLength(1);
    expect(rocketsFromEvents([])).toEqual([]);
  });
  it("preserves identifiers containing coordinate delimiters", () => expect(rocketsFromEvents([event({ tags: [["d", "SATURN:OPS"]] })]).at(-1)?.coordinate).toBe(`31108:${"2".repeat(64)}:SATURN:OPS`));
});
