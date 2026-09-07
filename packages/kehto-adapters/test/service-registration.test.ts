import type { Runtime, ServiceHandler } from "@kehto/runtime";
import { describe, expect, it, vi } from "vitest";
import { freshAdapters } from "./fresh.js";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { getSeenRelays } from "applesauce-core/helpers";
import type { StreamingOutboxRouter } from "@kehto/services";
import { EMPTY } from "rxjs";

describe("core service lifecycle", () => {
  it("bounds oversized NIP-65 relay categories", async () => {
    const { engine, adapters } = await freshAdapters();
    const relays = Array.from({ length: 12 }, (_, index) => `wss://relay-${index}.example`);
    expect(adapters.limitNip65RelayList([...relays, relays[0]!])).toEqual(relays.slice(0, 4));
    engine.shutdownNostrServices();
  });
  it("uses shell relay tiers for an ephemeral identity without NIP-65 mailboxes", async () => {
    const { engine, adapters } = await freshAdapters();
    const pubkey = await engine.accounts.connectEphemeral();
    const resolved = adapters.resolveRelayList(pubkey, { read: [], write: [] }, {
      activePubkey: pubkey,
      ephemeral: true,
      readRelays: ["wss://read.example/"],
      writeRelays: ["wss://write.example/"]
    });
    expect(resolved).toEqual({
      read: ["wss://read.example/"],
      write: ["wss://write.example/"]
    });
    engine.shutdownNostrServices();
  });
  it("publishes an ephemeral identity through the configured write tier", async () => {
    const handlers = new Map<string, ServiceHandler>();
    const runtime = {
      registerService: (name: string, handler: ServiceHandler) => handlers.set(name, handler),
      sessionRegistry: { getAllEntries: () => [] }
    } as unknown as Runtime;
    const { engine, adapters } = await freshAdapters();
    vi.spyOn(engine.relayPool, "request").mockReturnValue(EMPTY);
    const publish = vi.spyOn(engine.relayPool, "publish").mockImplementation(async (relays) => {
      if (!Array.isArray(relays)) throw new Error("expected fixed relay list");
      return relays.map((relay: string) => ({ from: relay, ok: true, message: "saved" }));
    });
    await engine.accounts.connectEphemeral();
    const registration = adapters.registerCoreServices({ runtime, publishIdentityChanged: vi.fn() }, {
      directReadRelays: ["wss://read.example/"],
      directWriteRelays: ["wss://write.example/"]
    });
    const send = vi.fn();
    handlers.get("outbox")!.handleMessage("window-1", {
      type: "outbox.publish",
      id: "publish-1",
      event: { kind: 1, created_at: 1, content: "ephemeral", tags: [] }
    } as never, send);

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 6_000 });

    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]?.[0]).toEqual(["wss://write.example/"]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "outbox.publish.result",
      id: "publish-1",
      ok: true,
      relays: { "wss://write.example/": true }
    }));
    registration.close(); engine.shutdownNostrServices();
  }, 7_000);
  it("does not replace declared or third-party NIP-65 relay lists", async () => {
    const { engine, adapters } = await freshAdapters();
    const fallback = {
      activePubkey: "11".repeat(32),
      ephemeral: true,
      readRelays: ["wss://fallback-read.example/"],
      writeRelays: ["wss://fallback-write.example/"]
    };
    expect(adapters.resolveRelayList(fallback.activePubkey, {
      read: ["wss://declared-read.example/"],
      write: ["wss://declared-write.example/"]
    }, fallback)).toEqual({
      read: ["wss://declared-read.example/"],
      write: ["wss://declared-write.example/"]
    });
    expect(adapters.resolveRelayList("22".repeat(32), { read: [], write: [] }, fallback))
      .toEqual({ read: [], write: [] });
    expect(adapters.resolveRelayList(fallback.activePubkey, { read: [], write: [] }, {
      ...fallback,
      ephemeral: false
    })).toEqual({ read: [], write: [] });
    engine.shutdownNostrServices();
  });
  it("notifies account-sensitive services for every live window on account change", async () => {
    const handlers = new Map<string, ServiceHandler>();
    const publishIdentityChanged = vi.fn();
    const runtime = {
      registerService: (name: string, handler: ServiceHandler) => handlers.set(name, handler),
      sessionRegistry: { getAllEntries: () => [{ windowId: "window-1" }, { windowId: "window-2" }] },
      injectEvent: vi.fn()
    } as unknown as Runtime;
    const { engine, adapters } = await freshAdapters();
    const registration = adapters.registerCoreServices({ runtime, publishIdentityChanged }, { directReadRelays: [], directWriteRelays: [] });
    const relayCleanup = vi.fn(); const outboxCleanup = vi.fn();
    handlers.get("relay")!.onWindowDestroyed = relayCleanup;
    handlers.get("outbox")!.onWindowDestroyed = outboxCleanup;
    engine.accounts.manager.active$.next(undefined);
    expect(relayCleanup.mock.calls).toEqual([["window-1"], ["window-2"]]);
    expect(outboxCleanup.mock.calls).toEqual([["window-1"], ["window-2"]]);
    expect(publishIdentityChanged).toHaveBeenCalledWith("");
    registration.close(); engine.shutdownNostrServices();
  });
  it("maps each Applesauce publish outcome to its relay", async () => {
    const { engine, adapters } = await freshAdapters();
    const publish = vi.spyOn(engine.relayPool, "publish").mockResolvedValue([
      { from: "wss://one.example/", ok: true, message: "saved" },
      { from: "wss://two.example/", ok: false, message: "blocked" }
    ]);
    const pool = adapters.createOutboxRelayPool([], ["wss://one.example/", "wss://two.example/"]);
    const event = finalizeEvent({ kind: 1, created_at: 1, content: "publish", tags: [] }, generateSecretKey());
    await expect(pool.publish(event, ["wss://one.example/", "wss://two.example/"])).resolves.toEqual({
      "wss://one.example/": true, "wss://two.example/": false
    });
    expect(publish).toHaveBeenCalledWith(["wss://one.example/", "wss://two.example/"], event, { retries: true, timeout: 4_000 });
    expect(engine.eventStore.getEvent(event.id)?.id).toBe(event.id);
    const invalid = { ...event, content: "tampered" };
    await expect(pool.publish(invalid, ["wss://one.example/"])).rejects.toThrow("invalid-event");
    expect(publish).toHaveBeenCalledOnce();
    engine.shutdownNostrServices();
  });
  it("records every relay accepting an outbox publication", async () => {
    const { engine, adapters } = await freshAdapters();
    vi.spyOn(engine.relayPool, "publish").mockResolvedValue([
      { from: "wss://one.example/", ok: true, message: "saved" },
      { from: "wss://two.example/", ok: true, message: "saved" }
    ]);
    const pool = adapters.createOutboxRelayPool([], ["wss://one.example/", "wss://two.example/"]);
    const event = finalizeEvent({ kind: 1, created_at: 1, content: "publish", tags: [] }, generateSecretKey());
    await pool.publish(event, ["wss://one.example/", "wss://two.example/"]);
    expect([...getSeenRelays(engine.eventStore.getEvent(event.id)!)!].sort()).toEqual(["wss://one.example/", "wss://two.example/"]);
    engine.shutdownNostrServices();
  });
  it("delivers successful local publications without relay echo", async () => {
    const { engine, adapters } = await freshAdapters();
    vi.spyOn(engine.relayPool, "publish").mockResolvedValue([
      { from: "wss://one.example/", ok: true, message: "saved" }
    ]);
    const relaySubscription = { close: vi.fn() };
    const relayRouter = {
      subscribe: vi.fn(() => relaySubscription),
      query: vi.fn(), queryStream: vi.fn(), publish: vi.fn(), resolveRelays: vi.fn()
    } as unknown as StreamingOutboxRouter;
    const sink = { event: vi.fn(), closed: vi.fn() };
    const subscription = adapters.createStoreAwareOutboxRouter(relayRouter, engine.eventStore)
      .subscribe([{ kinds: [31971] }], undefined, sink);
    const pool = adapters.createOutboxRelayPool([], ["wss://one.example/"]);
    const revision = finalizeEvent({ kind: 31971, created_at: 1, content: "updated", tags: [] }, generateSecretKey());

    await pool.publish(revision, ["wss://one.example/"]);

    expect(sink.event).toHaveBeenCalledOnce();
    expect(sink.event).toHaveBeenCalledWith({
      event: expect.objectContaining({ id: revision.id, content: "updated", kind: 31971 }),
      sidecar: { relayHints: ["wss://one.example/"] }
    });
    subscription.close();
    expect(relaySubscription.close).toHaveBeenCalledOnce();
    engine.shutdownNostrServices();
  });
  it("rejects excessive outbox filters before opening relay work", async () => {
    const { engine, adapters } = await freshAdapters(); const req = vi.spyOn(engine.relayPool, "req");
    const pool = adapters.createOutboxRelayPool(["wss://relay.example/"], []);
    expect(() => pool.subscribe(Array.from({ length: 9 }, () => ({})), ["wss://relay.example/"], vi.fn())).toThrow("invalid-filter");
    expect(req).not.toHaveBeenCalled();
    engine.shutdownNostrServices();
  });
  it("keeps service relay tiers synchronized with shell mutations", async () => {
    const { engine, adapters } = await freshAdapters();
    const configuration = adapters.createRelayConfiguration(engine.relayPolicy, { discovery: [], super: [], outbox: [] });
    const pool = adapters.createOutboxRelayPool(configuration.values("super"), configuration.values("outbox"));
    expect(pool.isAvailable()).toBe(false);
    const liveReadRelays = configuration.values("super");
    configuration.add("super", "wss://read.example");
    configuration.add("outbox", "wss://relay.example");
    expect(pool.isAvailable()).toBe(true);
    expect(liveReadRelays).toEqual(["wss://read.example/"]);
    expect(configuration.snapshot().outbox).toEqual(["wss://relay.example/"]);
    engine.shutdownNostrServices();
  });
  it("serves current profile and follows from the shared EventStore", async () => {
    const handlers = new Map<string, ServiceHandler>();
    const runtime = {
      registerService: (name: string, handler: ServiceHandler) => handlers.set(name, handler),
      sessionRegistry: { getAllEntries: () => [] }
    } as unknown as Runtime;
    const { engine, adapters } = await freshAdapters();
    const secret = generateSecretKey();
    const profile = finalizeEvent({ kind: 0, created_at: 2, content: JSON.stringify({ name: "alice", display_name: "Alice" }), tags: [] }, secret);
    const contacts = finalizeEvent({ kind: 3, created_at: 2, content: "", tags: [["p", "11".repeat(32)], ["p", "22".repeat(32)]] }, secret);
    engine.ingress.admit(profile, "local:test"); engine.ingress.admit(contacts, "local:test");
    const account = {
      id: "identity", type: "test", pubkey: profile.pubkey, signer: undefined as never,
      getPublicKey: async () => profile.pubkey, signEvent: vi.fn(), toJSON: () => ({})
    };
    account.signer = account as never; engine.accounts.manager.addAccount(account as never); engine.accounts.manager.setActive(account as never);
    const registration = adapters.registerCoreServices({ runtime, publishIdentityChanged: vi.fn() }, { directReadRelays: [], directWriteRelays: [] });
    const identity = handlers.get("identity")!;
    const profileSend = vi.fn(); const followsSend = vi.fn();
    identity.handleMessage("window-1", { type: "identity.getProfile", id: "profile" } as never, profileSend);
    identity.handleMessage("window-1", { type: "identity.getFollows", id: "follows" } as never, followsSend);
    await vi.waitFor(() => expect(profileSend).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(followsSend).toHaveBeenCalledOnce());
    expect(profileSend).toHaveBeenCalledWith({ type: "identity.getProfile.result", id: "profile", profile: { name: "alice", displayName: "Alice" } });
    expect(followsSend).toHaveBeenCalledWith({ type: "identity.getFollows.result", id: "follows", pubkeys: ["11".repeat(32), "22".repeat(32)] });
    registration.close(); engine.shutdownNostrServices();
  });
});
