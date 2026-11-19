import { describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/nostrocket-state.json";
import { firstMatchingState } from "./load";
import { NOSTROCKET_COORDINATE } from "./rockets";
import type { NostrEvent } from "./state";

describe("first state subscription", () => {
  it("closes immediately after first valid event", async () => { const callbacks = new Map<string, (value: never) => void>(); const close = vi.fn(); const subscribe = vi.fn(() => ({ on: (type: string, callback: (value: never) => void) => callbacks.set(type, callback), close })); const promise = firstMatchingState(subscribe, NOSTROCKET_COORDINATE, ["wss://relay.example/"]); callbacks.get("event")?.({ event: fixture as NostrEvent } as never); await expect(promise).resolves.toMatchObject({ id: fixture.id }); expect(close).toHaveBeenCalledTimes(1); expect(subscribe).toHaveBeenCalledWith([expect.objectContaining({ kinds: [31108], authors: [fixture.pubkey], "#d": ["NOSTROCKET"], limit: 1 })], expect.objectContaining({ relays: ["wss://relay.example/"], limit: 1 })); });
  it("keeps listening after malformed candidate", async () => { const callbacks = new Map<string, (value: never) => void>(); const close = vi.fn(); const subscribe = () => ({ on: (type: string, callback: (value: never) => void) => callbacks.set(type, callback), close }); const promise = firstMatchingState(subscribe, NOSTROCKET_COORDINATE, []); callbacks.get("event")?.({ event: { ...fixture, kind: 1 } } as never); expect(close).not.toHaveBeenCalled(); callbacks.get("event")?.({ event: fixture } as never); await expect(promise).resolves.toMatchObject({ id: fixture.id }); });
  it("rejects when the subscription closes before a valid event", async () => {
    const callbacks = new Map<string, (value: never) => void>();
    const subscribe = () => ({ on: (type: string, callback: (value: never) => void) => callbacks.set(type, callback), close: vi.fn() });
    const promise = firstMatchingState(subscribe, NOSTROCKET_COORDINATE, []);
    callbacks.get("closed")?.({ reason: "relay unavailable" } as never);
    await expect(promise).rejects.toThrow(/closed before a valid event/);
  });
  it("rejects when no state arrives before the timeout", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      const subscribe = () => ({ on: vi.fn(), close });
      const promise = firstMatchingState(subscribe, NOSTROCKET_COORDINATE, [], 1000);
      vi.advanceTimersByTime(1000);
      await expect(promise).rejects.toThrow(/was not found within 1000ms/);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
