import { expect, test } from "@playwright/test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

declare global {
  interface Window {
    __platformTest?: {
      windows: { listWindowIds(): readonly string[] };
      destroyWindow(windowId: string): void;
      authenticatedWindowIds(): readonly string[];
      telemetrySnapshot(): readonly { name: string; value: number }[];
      dockLaunchers(): Promise<readonly { coordinate: string; dTag: string }[]>;
      connectExtension(): Promise<string>;
      signOut(): void;
    };
  }
}

test("starts under repository subpath and gains service-worker control", async ({ page }) => {
  await page.goto("./");
  await expect(page).toHaveTitle("Rocketshell");
  await expect(page.locator("#status")).toBeHidden();
  expect(await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration("/rocketshell/")))).toBe(true);
  await page.reload();
  await expect(page.locator("#status")).toBeHidden();
  expect(await page.evaluate(() => new URL(navigator.serviceWorker.controller!.scriptURL).pathname.endsWith("/rocketshell/service-worker.js"))).toBe(true);
  expect(await page.evaluate(async () => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) return false;
    const expected = new URL(controller.scriptURL).searchParams.get("build");
    const channel = new MessageChannel();
    const reply = new Promise<any>((resolve) => { channel.port1.onmessage = (event) => resolve(event.data); });
    controller.postMessage({ protocolVersion: 1, requestId: "browser-build-check", type: "PING" }, [channel.port2]);
    return (await reply).buildId === expected;
  })).toBe(true);
});

test("replaces persisted stale built-in bytes without clearing browser data", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toBeHidden();
  await page.getByRole("button", { name: "Open View Problem" }).click();
  const iframe = page.locator('iframe[title="view-problem"]');
  await expect(iframe).toBeVisible();
  const currentVirtualUrl = await iframe.getAttribute("data-virtual-url");
  const currentAggregate = currentVirtualUrl?.match(/\/([a-f0-9]{64})\/index\.html$/)?.[1];
  expect(currentAggregate).toBeTruthy();

  const staleAggregate = await page.evaluate(async ({ currentAggregate }) => {
    const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const hash = async (bytes: Uint8Array): Promise<string> => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("napplet-packages");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const currentPackage = await new Promise<Record<string, any>>((resolve, reject) => {
      const transaction = database.transaction("packages", "readonly");
      const get = transaction.objectStore("packages").get(`view-problem\0${currentAggregate}`);
      get.onerror = () => reject(get.error); get.onsuccess = () => resolve(get.result);
    });
    const stale = structuredClone(currentPackage);
    const staleBytes = new TextEncoder().encode("<!doctype html><div id=\"stale-version\">Version A</div>");
    const staleHash = await hash(staleBytes);
    const declarations = stale.manifest.artifacts.map((artifact: { path: string; sha256: string; mediaType: string }) => artifact.path === "index.html"
      ? { ...artifact, sha256: staleHash }
      : artifact);
    const aggregateInput = declarations
      .sort((left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path))
      .map((artifact: { path: string; sha256: string }) => `${artifact.sha256} /${artifact.path.replace(/^\/+/, "")}\n`)
      .join("");
    const staleAggregate = await hash(new TextEncoder().encode(aggregateInput));
    stale.packageKey = `view-problem\0${staleAggregate}`;
    stale.aggregateHash = staleAggregate;
    stale.manifest.aggregateHash = staleAggregate;
    stale.manifest.artifacts = declarations;
    stale.artifacts = stale.artifacts.map((artifact: { path: string; bytes: Uint8Array; mediaType: string }) => artifact.path === "index.html"
      ? { ...artifact, sha256: staleHash, bytes: staleBytes }
      : artifact);
    stale.manifestEvent.content = JSON.stringify(stale.manifest);
    stale.manifestEvent.tags = stale.manifestEvent.tags.map((tag: string[]) => tag[0] === "x" && tag[2] === "aggregate"
      ? ["x", staleAggregate, "aggregate"]
      : tag[0] === "path" && tag[1] === "/index.html"
        ? ["path", "/index.html", staleHash]
        : tag);
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(["packages", "active"], "readwrite");
      transaction.objectStore("packages").put(stale);
      transaction.objectStore("active").put({ dTag: "view-problem", aggregateHash: staleAggregate });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    const currentRegistry = await (await fetch("/rocketshell/napplets.json", { cache: "no-store" })).json();
    const staleRegistry = {
      ...currentRegistry,
      napplets: currentRegistry.napplets.map((napplet: { dTag: string; files: unknown[] }) => napplet.dTag === "view-problem"
        ? { ...napplet, files: declarations }
        : napplet)
    };
    const cache = await caches.open("platform-shell-legacy-test");
    await cache.put("/rocketshell/napplets.json", new Response(JSON.stringify(staleRegistry), {
      headers: { "Content-Type": "application/json" }
    }));
    return staleAggregate;
  }, { currentAggregate: currentAggregate! });
  expect(staleAggregate).not.toBe(currentAggregate);

  await page.evaluate(async () => {
    const controllerChanged = new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
    await navigator.serviceWorker.register("/rocketshell/legacy-service-worker.js", { scope: "/rocketshell/", updateViaCache: "none" });
    if (!navigator.serviceWorker.controller?.scriptURL.endsWith("/legacy-service-worker.js")) await controllerChanged;
  });
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/legacy-service-worker.js"))).toBe(true);

  await page.reload();
  await expect(page.locator("#status")).toBeHidden();
  expect(await page.evaluate(() => new URL(navigator.serviceWorker.controller!.scriptURL).pathname.endsWith("/service-worker.js"))).toBe(true);
  expect(await page.evaluate(async () => Boolean(await caches.match("/legacy-registry-read")))).toBe(false);
  const restored = page.locator('iframe[title="view-problem"]');
  await expect(restored).toBeVisible();
  await expect(restored).toHaveAttribute("data-virtual-url", new RegExp(`/${currentAggregate}/index\\.html$`));
  await expect(page.frameLocator('iframe[title="view-problem"]').locator("#stale-version")).toHaveCount(0);
  await expect(page.frameLocator('iframe[title="view-problem"]').locator("#app")).toBeVisible();
  const activeAggregate = await page.evaluate(async () => new Promise<string | undefined>((resolve, reject) => {
    const request = indexedDB.open("napplet-packages");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("active", "readonly");
      const get = transaction.objectStore("active").get("view-problem");
      get.onerror = () => reject(get.error);
      get.onsuccess = () => { database.close(); resolve(get.result?.aggregateHash); };
    };
  }));
  expect(activeAggregate).toBe(currentAggregate);

  await page.reload();
  await expect(page.locator('iframe[title="view-problem"]')).toBeVisible();
  await expect(page.locator('iframe[title="view-problem"]')).toHaveAttribute("data-virtual-url", new RegExp(`/${currentAggregate}/index\\.html$`));
});

test("build contains no root-relative project asset URLs", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toHaveText("Platform ready");
  const urls = await page.locator("script[src],link[href]").evaluateAll((elements) => elements.map((element) => element.getAttribute("src") ?? element.getAttribute("href")));
  expect(urls.filter(Boolean).every((url) => url!.startsWith("/rocketshell/") || url!.startsWith("./"))).toBe(true);
});

test("isolates package, public event, and private account persistence", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toHaveText("Platform ready");
  const names = await page.evaluate(async () => (await indexedDB.databases()).map((database) => database.name));
  expect(names).toEqual(expect.arrayContaining(["napplet-packages", "platform-events", "platform-private", "platform-metadata"]));
  expect(new Set(names).size).toBe(names.length);
  const metadata = await page.evaluate(async () => new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = indexedDB.open("platform-metadata");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction("records", "readonly");
      const get = transaction.objectStore("records").get("compatibility");
      get.onerror = () => reject(get.error); get.onsuccess = () => resolve(get.result);
    };
  }));
  expect(metadata).toMatchObject({ profile: "platform-nap-v1", schemaVersions: { metadata: 1, packages: 1, privateAccounts: 1 } });
});

test("runs verified fixture as opaque network-isolated Napplet", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#fixture-status")).toHaveText("ready");
  const dataset = await frame.locator("html").evaluate((element) => ({ ...element.dataset }));
  expect(dataset.resourceError).toBe("");
  expect(dataset).toMatchObject({ origin: "null", nostr: "undefined", storageBlocked: "true", persistenceSealed: "true", hostDomBlocked: "true", fetchBlocked: "true", websocketBlocked: "true", relayQueried: "true", resourceFetched: "true", resourceObjectUrl: "true", resourceRevoked: "true", pubkey: "", intentReceived: "true", intentStructured: "true", platformProfile: "true", optionalAbsent: "true" });
  expect(await page.locator("iframe").getAttribute("data-virtual-url")).toMatch(/^\/shell\/__napplet__\/platform-fixture\/[a-f0-9]{64}\/index\.html$/);
  expect(await page.evaluate(() => window.__platformTest?.telemetrySnapshot().some((record) => record.name === "window.active" && record.value === 1))).toBe(true);
});

test("fetches resource bytes through the sandbox bridge", async ({ page, context }) => {
  const resourceUrl = "http://127.0.0.1:4173/rocketshell/resource-test.png";
  const requests: { method: string; authorization: string; cookie: string; referer: string }[] = [];
  page.on("request", (request) => {
    if (request.url() !== resourceUrl) return;
    const headers = request.headers();
    requests.push({
      method: request.method(),
      authorization: headers.authorization ?? "",
      cookie: headers.cookie ?? "",
      referer: headers.referer ?? ""
    });
  });
  await context.addCookies([{ name: "resource-test", value: "secret", url: "http://127.0.0.1:4173" }]);
  await page.goto("./");

  const frame = page.frameLocator('iframe[title="platform-fixture"]');
  await expect(frame.locator("#fixture-status")).toHaveText("ready");
  await frame.getByTestId("resource-url").fill(resourceUrl);
  await frame.getByTestId("resource-request").click();

  await expect.poll(async () => frame.locator("body").getAttribute("data-resource-result")).not.toBe("");
  const result = JSON.parse((await frame.locator("body").getAttribute("data-resource-result")) ?? "null");
  expect(result).toEqual({ ok: true, type: "image/png", size: 8, firstBytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] });
  expect(requests.at(-1)).toEqual({ method: "GET", authorization: "", cookie: "", referer: "" });
});

test("moves widgets by toolbar drag and keeps resize handles independent", async ({ page }) => {
  await page.goto("./");
  await expect(page.frameLocator("iframe").locator("#fixture-status")).toHaveText("ready");
  await page.locator("#windows").evaluate((windows) => {
    const widget = document.createElement("article");
    widget.id = "drag-fixture";
    widget.className = "napplet-window";
    widget.innerHTML = '<header class="napplet-window-toolbar"><span class="napplet-window-title">Drag fixture</span></header><div></div>';
    windows.append(widget);
  });
  const first = page.locator(".napplet-window").first();
  const second = page.locator("#drag-fixture");
  await expect(second.locator(".napplet-resize-both")).toBeVisible();
  const firstColumn = await first.evaluate((element) => element.style.gridColumn);
  const secondColumn = await second.evaluate((element) => element.style.gridColumn);
  const firstToolbar = first.locator(".napplet-window-toolbar");
  const secondToolbar = second.locator(".napplet-window-toolbar");
  const from = await firstToolbar.boundingBox();
  const to = await secondToolbar.boundingBox();
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  await page.mouse.move(from!.x + 20, from!.y + from!.height / 2);
  await page.mouse.down();
  await expect(page.locator("#windows")).toHaveAttribute("data-interacting", "move");
  await expect(page.locator("#windows iframe")).toHaveCSS("pointer-events", "none");
  await page.mouse.move(to!.x + 20, to!.y + to!.height / 2, { steps: 4 });
  const previews = page.locator(".napplet-pack-preview");
  await expect(previews).toHaveCount(2);
  await expect(previews.filter({ hasText: "Drag fixture" })).toHaveAttribute("data-placement", "swap");
  await expect(previews.filter({ hasText: "Platform Fixture" })).toHaveAttribute("data-placement", "swap");
  await page.mouse.up();
  await expect(previews).toHaveCount(0);
  await expect.poll(() => first.evaluate((element) => (element as HTMLElement).style.gridColumn)).toBe(secondColumn);
  await expect.poll(() => second.evaluate((element) => (element as HTMLElement).style.gridColumn)).toBe(firstColumn);

  const movedFirstColumn = await first.evaluate((element) => element.style.gridColumn);
  const movedSecondColumn = await second.evaluate((element) => element.style.gridColumn);
  await page.locator("#windows").evaluate((windows) => {
    const widget = document.createElement("article");
    widget.id = "new-fixture";
    widget.className = "napplet-window";
    widget.innerHTML = '<header class="napplet-window-toolbar"><span class="napplet-window-title">New fixture</span></header><div></div>';
    windows.append(widget);
  });
  await expect(page.locator("#new-fixture .napplet-resize-both")).toBeVisible();
  await expect(first).toHaveCSS("grid-column", "3 / span 2");
  await expect(second).toHaveCSS("grid-column", "1 / span 2");
  expect(await first.evaluate((element) => element.style.gridColumn)).toBe(movedFirstColumn);
  expect(await second.evaluate((element) => element.style.gridColumn)).toBe(movedSecondColumn);

  const leftResizeHandle = first.locator(".napplet-resize-inline-start");
  await expect(leftResizeHandle).toHaveCSS("cursor", "ew-resize");
  const leftHandleBounds = await leftResizeHandle.boundingBox();
  const gridStep = await page.locator("#windows").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const styles = getComputedStyle(element);
    const gap = Number.parseFloat(styles.columnGap) || 0;
    return (bounds.width - gap * 3) / 4 + gap;
  });
  expect(leftHandleBounds).not.toBeNull();
  await page.waitForTimeout(300);
  await leftResizeHandle.hover({ position: { x: 2, y: 60 } });
  await page.mouse.down();
  await expect(page.locator("#windows")).toHaveAttribute("data-interacting", "resize");
  await page.mouse.move(leftHandleBounds!.x - gridStep + 2, leftHandleBounds!.y + 60);
  await page.mouse.up();
  await expect.poll(() => first.evaluate((element) => element.style.gridColumn)).toBe("2 / span 3");
  await expect.poll(() => second.evaluate((element) => element.style.gridColumn)).toBe("1 / span 1");

  const resizeHandle = second.locator(".napplet-resize-inline");
  await page.waitForTimeout(300);
  await resizeHandle.hover({ position: { x: 2, y: 30 } });
  await page.mouse.down();
  await expect(page.locator("#windows")).toHaveAttribute("data-interacting", "resize");
  await page.mouse.up();
  await expect(page.locator("#windows")).not.toHaveAttribute("data-interacting");

  const persistedFirstColumn = await first.evaluate((element) => element.style.gridColumn);
  await page.reload();
  await expect(page.frameLocator("iframe").locator("#fixture-status")).toHaveText("ready");
  await expect.poll(() => page.locator(".napplet-window").first().evaluate((element) => element.style.gridColumn)).toBe(persistedFirstColumn);
});

test("restores saved geometry when only one window is open", async ({ page }) => {
  await page.goto("./");
  await expect(page.frameLocator("iframe").locator("#fixture-status")).toHaveText("ready");
  await page.evaluate(() => {
    localStorage.setItem("shell.widget-layout.v1", JSON.stringify({
      version: 1,
      profiles: {
        laptop: {
          "platform-fixture#0": { column: 1, row: 1, width: 2, height: 1 }
        }
      }
    }));
  });

  await page.reload();

  const window = page.locator(".napplet-window").first();
  await expect(window).toHaveCSS("grid-column", "2 / span 2");
  await expect(window).toHaveCSS("grid-row", "2 / span 1");
});

test("settles intent result before caller navigation unmounts it", async ({ page }) => {
  await page.goto("./");
  const frame = page.frameLocator('iframe[title="platform-fixture"]');
  await expect(frame.locator("#fixture-status")).toHaveText("ready");
  const result = page.evaluate(() => new Promise<unknown>((resolve) => {
    const listener = (event: MessageEvent): void => {
      if (event.data?.type !== "platform-test.intent-before-navigation") return;
      window.removeEventListener("message", listener);
      resolve(event.data.result);
    };
    window.addEventListener("message", listener);
  }));
  await frame.locator("html").evaluate(() => {
    void window.napplet.intent.invoke({
      archetype: "fixture", action: "open", convention: "napplet:fixture/open", payload: { navigation: true }
    }).then((intentResult) => {
      parent.postMessage({ type: "platform-test.intent-before-navigation", result: intentResult }, "*");
      location.replace("about:blank");
    });
  });
  await expect(result).resolves.toMatchObject({
    ok: true, handled: true, archetype: "fixture", action: "open", handler: "platform-fixture"
  });
  await expect.poll(() => page.frames().some((candidate) => candidate !== page.mainFrame() && candidate.url() === "about:blank")).toBe(true);
});

test("restores intent-created problem window with its tree caller", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toHaveText("Platform ready");
  await page.getByRole("button", { name: "Open Navigate Problem Tree" }).click();
  const tree = page.frameLocator('iframe[title="navigate-problem-tree"]');
  await expect(tree.locator("#app")).toBeVisible();

  const result = await tree.locator("html").evaluate(async () => window.napplet.intent.invoke({
    archetype: "note", action: "open", convention: "napplet:note/open",
    payload: { target: { type: "event", id: "0".repeat(64) } },
    behavior: { focus: true, reuse: true }
  }));
  expect(result).toMatchObject({ ok: true, handled: true, handler: "view-problem" });
  await expect(page.locator('iframe[title="view-problem"]')).toHaveCount(1);
  const problem = page.frameLocator('iframe[title="view-problem"]');
  await expect(problem.locator("#setup-status")).toHaveText("Selected problem revision was not found.");
  await expect.poll(() => page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("shell.window-session.v2") ?? "null");
    return session?.windows?.map((window: { dTag: string }) => window.dTag);
  })).toEqual(["navigate-problem-tree", "view-problem"]);

  await page.reload();

  await expect(page.locator('iframe[title="navigate-problem-tree"]')).toHaveCount(1);
  await expect(page.locator('iframe[title="view-problem"]')).toHaveCount(1);
  await expect(page.locator('iframe[title="navigate-problem-tree"]').locator("..")).toBeHidden();
  await expect(page.locator('iframe[title="view-problem"]').locator("..")).toBeVisible();
  await expect(page.frameLocator('iframe[title="view-problem"]').locator("#setup-status"))
    .toHaveText("Selected problem revision was not found.");
  expect(await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("shell.window-session.v2") ?? "null");
    return session?.windows?.find((window: { dTag: string }) => window.dTag === "view-problem")?.launch;
  })).toMatchObject({
    type: "intent", sender: "navigate-problem-tree", convention: "napplet:note/open",
    payload: { target: { type: "event", id: "0".repeat(64) } }
  });
});

test("keeps problem-tree geometry stable while reusing the visible viewer", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __intentRequests: unknown[] }).__intentRequests = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type === "intent.invoke") {
        (window as unknown as { __intentRequests: unknown[] }).__intentRequests.push(event.data.request);
      }
    }, { capture: true });
  });
  await page.goto("./");
  await expect(page.getByRole("button", { name: "Open Navigate Problem Tree" })).toBeVisible();
  await page.getByRole("button", { name: "Open Navigate Problem Tree" }).click();
  const tree = page.frameLocator('iframe[title="navigate-problem-tree"]');
  await expect(tree.getByRole("button", { name: /Bitcoin is not fixing/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("shell.window-session.v2") ?? "null");
    return session?.windows?.map((window: { dTag: string }) => window.dTag);
  })).toEqual(["navigate-problem-tree"]);
  await tree.getByRole("button", { name: /Nostrocket is not currently applicable/ }).click();
  await expect(page.locator('iframe[title="view-problem"]')).toHaveCount(1);
  await expect(page.locator('iframe[title="navigate-problem-tree"]').locator("..")).toBeVisible();
  await expect(page.locator('iframe[title="view-problem"]').locator("..")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("shell.window-session.v2") ?? "null");
    return session?.windows?.map((window: { dTag: string }) => window.dTag);
  })).toEqual(["navigate-problem-tree", "view-problem"]);
  const readGridPlacements = () => page.locator('iframe[title="navigate-problem-tree"], iframe[title="view-problem"]').evaluateAll((iframes) =>
    Object.fromEntries(iframes.map((iframe) => {
      const style = getComputedStyle(iframe.parentElement!);
      return [iframe.getAttribute("title"), { gridColumn: style.gridColumn, gridRow: style.gridRow }];
    }))
  );
  const placementBeforeRefresh = await readGridPlacements();
  await page.reload();
  await expect(page.locator('iframe[title="navigate-problem-tree"]').locator("..")).toBeVisible();
  await expect(page.locator('iframe[title="view-problem"]').locator("..")).toBeVisible();
  await expect(tree.getByRole("button", { name: /Nostrocket napplets are missing/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("shell.window-session.v2") ?? "null");
    return session?.windows?.map((window: { dTag: string }) => window.dTag);
  })).toEqual(["navigate-problem-tree", "view-problem"]);
  expect(await readGridPlacements()).toEqual(placementBeforeRefresh);
  await tree.locator(".tree-pane").evaluate((pane) => { pane.scrollTop = 100; });
  await page.waitForTimeout(500);

  const shellSamplesPromise = page.locator('iframe[title="navigate-problem-tree"]').evaluate((iframe) => new Promise<unknown[]>((resolve) => {
    const samples: unknown[] = [];
    const start = performance.now();
    const sample = () => {
      const rect = iframe.getBoundingClientRect();
      const host = iframe.parentElement;
      const styles = host ? getComputedStyle(host) : undefined;
      samples.push({ time: performance.now() - start, rect: [rect.x, rect.y, rect.width, rect.height], gridColumn: styles?.gridColumn, gridRow: styles?.gridRow, hidden: host?.hidden });
      if (performance.now() - start < 800) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));
  const frameSamplesPromise = tree.locator("html").evaluate(() => new Promise<unknown[]>((resolve) => {
    const samples: unknown[] = [];
    const start = performance.now();
    const sample = () => {
      const pane = document.querySelector<HTMLElement>(".tree-pane")!;
      const paneStyle = getComputedStyle(pane);
      samples.push({
        time: performance.now() - start,
        viewport: [innerWidth, innerHeight, document.documentElement.clientWidth, document.documentElement.clientHeight],
        document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
        pane: [pane.clientWidth, pane.clientHeight, pane.scrollWidth, pane.scrollHeight, pane.scrollTop],
        scrollbar: [pane.scrollHeight > pane.clientHeight, pane.scrollWidth > pane.clientWidth],
        fontStatus: document.fonts.status,
        paneStyle: [paneStyle.padding, paneStyle.font, paneStyle.fontWeight, paneStyle.lineHeight, paneStyle.transform],
        gridColumns: getComputedStyle(document.querySelector<HTMLElement>(".workspace")!).gridTemplateColumns,
        nodes: Array.from(document.querySelectorAll<HTMLElement>(".tree-node")).map((node) => {
          const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
          return [node.textContent?.trim(), rect.x, rect.y, rect.width, rect.height, style.padding, style.font, style.fontWeight, style.lineHeight, style.transform];
        }),
        connectors: Array.from(document.querySelectorAll<HTMLElement>(".incoming-connector, .connector-line, .connector-arrow, .branch > ul")).map((node) => {
          const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
          return [node.className, rect.x, rect.y, rect.width, rect.height, style.transform];
        })
      });
      if (performance.now() - start < 800) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }));
  await tree.getByRole("button", { name: /Can't submit patches on problems/ }).click();
  const [shellSamples, frameSamples] = await Promise.all([shellSamplesPromise, frameSamplesPromise]);
  const unique = (values: unknown[]) => Array.from(new Set(values.map((value) => JSON.stringify(value)))).map((value) => JSON.parse(value));
  const typedFrame = frameSamples as Array<Record<string, unknown>>;
  expect(unique((shellSamples as Array<Record<string, unknown>>).map(({ rect, gridColumn, gridRow, hidden }) => ({ rect, gridColumn, gridRow, hidden })))).toHaveLength(1);
  expect(unique(typedFrame.map((sample) => sample.viewport))).toHaveLength(1);
  expect(unique(typedFrame.map((sample) => sample.pane))).toHaveLength(1);
  expect(unique(typedFrame.map((sample) => sample.scrollbar))).toHaveLength(1);
  expect(unique(typedFrame.map((sample) => sample.fontStatus))).toEqual(["loaded"]);
  expect(unique(typedFrame.map((sample) => sample.paneStyle))).toHaveLength(1);
  expect(unique(typedFrame.map((sample) => sample.gridColumns))).toHaveLength(1);
  expect(unique(typedFrame.map((sample) => sample.nodes))).toHaveLength(1);
  await expect(tree.locator('.tree-node[aria-current="true"]')).toContainText("Can't submit patches on problems");
  expect(await page.evaluate(() => (window as unknown as { __intentRequests: Array<{ behavior?: unknown }> }).__intentRequests.at(-1)?.behavior))
    .toEqual({ focus: false, reuse: true });
  await expect(page.locator('iframe[title="navigate-problem-tree"]').locator("..")).toBeVisible();
  await expect(page.locator('iframe[title="view-problem"]').locator("..")).toBeVisible();
});

test("reuses merit composer beside problem viewer across refresh", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toBeHidden();
  await expect.poll(() => page.evaluate(() => Boolean(window.__platformTest))).toBe(true);
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("napplet-packages");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const active = await new Promise<{ aggregateHash: string }>((resolve, reject) => {
      const request = database.transaction("active", "readonly").objectStore("active").get("request-merits");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const packageKey = `request-merits\0${active.aggregateHash}`;
    const installed = await new Promise<Record<string, any>>((resolve, reject) => {
      const request = database.transaction("packages", "readonly").objectStore("packages").get(packageKey);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    delete installed.manifest.archetypes;
    installed.manifestEvent.tags = installed.manifestEvent.tags.filter((tag: string[]) => tag[0] !== "archetype");
    const content = JSON.parse(installed.manifestEvent.content);
    delete content.archetypes;
    installed.manifestEvent.content = JSON.stringify(content);
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("packages", "readwrite");
      transaction.objectStore("packages").put(installed);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload();
  await expect(page.locator("#status")).toBeHidden();
  await page.evaluate(async () => {
    const platform = window.__platformTest as unknown as {
      openInstalled(dTag: string): Promise<{ windowId: string }>;
      windows: { setLaunchDescriptor(windowId: string, launch: { type: "direct"; coordinate: string }): void };
    };
    const viewer = await platform.openInstalled("view-problem");
    platform.windows.setLaunchDescriptor(viewer.windowId, { type: "direct", coordinate: "view-problem" });
  });
  const viewer = page.frameLocator('iframe[title="view-problem"]');
  await expect(viewer.locator("#app")).toBeVisible();

  const result = await viewer.locator("html").evaluate(async () => window.napplet.intent.invoke({
    archetype: "composer", action: "merit-request", convention: "napplet:composer/merit-request",
    payload: { problem: "Closed problem" }, behavior: { focus: false, reuse: true }
  }));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, handled: true, handler: "request-merits" });
  const merits = page.frameLocator('iframe[title="request-merits"]');
  await expect(merits.getByRole("heading", { name: "Request merits" })).toBeVisible();
  await expect(merits.getByLabel("Problem or work addressed")).toHaveValue("Closed problem");
  await expect(page.locator('iframe[title="view-problem"]').locator("..")).toBeVisible();
  await expect(page.locator('iframe[title="request-merits"]').locator("..")).toBeVisible();

  const windowSelector = 'iframe[title="view-problem"], iframe[title="request-merits"]';
  const readPlacements = () => page.locator(windowSelector).evaluateAll((iframes) => Object.fromEntries(iframes.map((iframe) => {
    const style = getComputedStyle(iframe.parentElement!);
    return [iframe.getAttribute("title"), { gridColumn: style.gridColumn, gridRow: style.gridRow }];
  })));
  const placementBeforeRefresh = await readPlacements();
  await expect.poll(() => page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("shell.window-session.v2") ?? "null");
    return session?.windows?.map((window: { dTag: string }) => window.dTag);
  })).toEqual(["view-problem", "request-merits"]);

  await page.reload();

  await expect(page.locator('iframe[title="view-problem"]').locator("..")).toBeVisible();
  await expect(page.locator('iframe[title="request-merits"]').locator("..")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem("shell.window-session.v2") ?? "null");
    return session?.windows?.map((window: { dTag: string }) => window.dTag);
  })).toEqual(["view-problem", "request-merits"]);
  expect(await readPlacements()).toEqual(placementBeforeRefresh);
});

test("never exposes an empty white Napplet frame during startup", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toHaveText("Platform ready");
  await page.evaluate(() => {
    const samples: Array<{ title: string; visible: boolean; content: string }> = [];
    const windows = document.querySelector("#windows");
    if (!windows) throw new Error("Napplet window container is missing");
    new MutationObserver((records, observer) => {
      for (const record of records) for (const added of record.addedNodes) {
        if (!(added instanceof HTMLElement) || !added.classList.contains("napplet-window")) continue;
        const frame = added.querySelector("iframe");
        samples.push({
          title: frame?.title ?? "",
          visible: !added.hidden && getComputedStyle(added).display !== "none",
          content: frame?.contentDocument?.body?.textContent?.trim() ?? ""
        });
        if (frame?.title === "view-problem") observer.disconnect();
      }
    }).observe(windows, { childList: true });
    (window as unknown as { __startupFrameSamples: typeof samples }).__startupFrameSamples = samples;
  });

  await page.evaluate(async () => {
    const platform = window.__platformTest as unknown as { openInstalled(dTag: string): Promise<unknown> };
    await platform.openInstalled("view-problem");
  });

  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __startupFrameSamples?: Array<{ title: string }> }).__startupFrameSamples
      ?.some(({ title }) => title === "view-problem") ?? false
  )).toBe(true);
  expect(await page.evaluate(() =>
    (window as unknown as { __startupFrameSamples: Array<{ title: string; visible: boolean; content: string }> })
      .__startupFrameSamples.find(({ title }) => title === "view-problem")
  )).not.toMatchObject({ visible: true, content: "" });
});

test("renders Problem View before identity initialization settles", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __blockedProblemIdentity: boolean }).__blockedProblemIdentity = false;
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "identity.getPublicKey") return;
      const problemFrame = [...document.querySelectorAll<HTMLIFrameElement>("iframe")]
        .find((frame) => frame.title === "view-problem");
      if (!problemFrame || event.source !== problemFrame.contentWindow) return;
      event.stopImmediatePropagation();
      (window as unknown as { __blockedProblemIdentity: boolean }).__blockedProblemIdentity = true;
    }, { capture: true });
  });
  await page.goto("./");
  await expect(page.locator("#status")).toHaveText("Platform ready");

  const opening = page.evaluate(async () => {
    const platform = window.__platformTest as unknown as { openInstalled(dTag: string): Promise<unknown> };
    return platform.openInstalled("view-problem");
  });
  await expect(opening).resolves.toBeDefined();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __blockedProblemIdentity: boolean }).__blockedProblemIdentity
  )).toBe(true);

  await expect(page.frameLocator('iframe[title="view-problem"]').locator("#app"))
    .not.toBeEmpty();
});

test("mediates Blossom upload without exposing signer or server selection", async ({ page }) => {
  // The shell reads its media servers from the settings store, so point it at the mock server there.
  // Keys left out fall back to the shipped defaults.
  await page.addInitScript(() => {
    localStorage.setItem("platform:settings:v1", JSON.stringify({ backupBlossomServers: ["http://127.0.0.1:4173/mock-blossom"] }));
  });
  const secret = new Uint8Array(32); secret[31] = 7;
  const pubkey = getPublicKey(secret);
  await page.exposeFunction("__platformTestSignEvent", (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, secret));
  await page.addInitScript((activePubkey) => {
    Object.defineProperty(window, "nostr", { value: {
      getPublicKey: async () => activePubkey,
      signEvent: (template: { kind: number; created_at: number; content: string; tags: string[][] }) => (window as unknown as { __platformTestSignEvent(value: typeof template): Promise<unknown> }).__platformTestSignEvent(template)
    }, configurable: true });
  }, pubkey);
  await page.goto("./");
  await expect(page.frameLocator('iframe[title="platform-fixture"]').locator("#fixture-status")).toHaveText("ready");
  await page.evaluate(() => window.__platformTest?.connectExtension());
  await expect(page.frameLocator('iframe[title="platform-fixture"]').locator("html")).toHaveAttribute("data-identity-latest", pubkey);
  const result = await page.frameLocator('iframe[title="platform-fixture"]').locator("html").evaluate(async () => {
    const value = await window.napplet.upload.upload({ data: new Blob(["host-owned upload"], { type: "text/plain" }), rail: "blossom", filename: "proof.txt", mimeType: "text/plain" });
    return {
      ok: value.ok, rail: value.rail, url: value.url, size: value.size, error: value.error,
      signer: typeof window.nostr,
      rawFetchServerKnown: document.documentElement.innerHTML.includes("mock-blossom")
    };
  });
  expect(result).toEqual({
    ok: true, rail: "blossom", url: `https://cdn.example/${pubkey}/uploaded.txt`, size: 17, error: undefined,
    signer: "undefined", rawFetchServerKnown: false
  });
  await page.evaluate(() => window.__platformTest?.signOut());
  await expect(page.frameLocator('iframe[title="platform-fixture"]').locator("html")).toHaveAttribute("data-identity-latest", "");
  expect(Number(await page.frameLocator('iframe[title="platform-fixture"]').locator("html").getAttribute("data-identity-changes"))).toBeGreaterThanOrEqual(2);
});

test("invalidates in-flight signing and pushes an account switch", async ({ page }) => {
  const firstSecret = new Uint8Array(32); firstSecret[31] = 8;
  const secondSecret = new Uint8Array(32); secondSecret[31] = 9;
  let activeSecret = firstSecret;
  let releaseSigning: (() => void) | undefined;
  let signingStarted: (() => void) | undefined;
  const signingGate = new Promise<void>((resolve) => { releaseSigning = resolve; });
  const started = new Promise<void>((resolve) => { signingStarted = resolve; });
  await page.exposeFunction("__platformTestPublicKey", () => getPublicKey(activeSecret));
  await page.exposeFunction("__platformTestDelayedSign", async (template: Parameters<typeof finalizeEvent>[0]) => {
    const operationSecret = activeSecret;
    signingStarted?.();
    await signingGate;
    return finalizeEvent(template, operationSecret);
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "nostr", { value: {
      getPublicKey: () => (window as unknown as { __platformTestPublicKey(): Promise<string> }).__platformTestPublicKey(),
      signEvent: (template: { kind: number; created_at: number; content: string; tags: string[][] }) => (window as unknown as { __platformTestDelayedSign(value: typeof template): Promise<unknown> }).__platformTestDelayedSign(template)
    }, configurable: true });
  });
  await page.goto("./");
  const frame = page.frameLocator('iframe[title="platform-fixture"]');
  await expect(frame.locator("#fixture-status")).toHaveText("ready");
  await page.evaluate(() => window.__platformTest?.connectExtension());
  await expect(frame.locator("html")).toHaveAttribute("data-identity-latest", getPublicKey(firstSecret));
  await frame.locator("html").evaluate((element) => {
    void window.napplet.upload.upload({ data: new Blob(["pending"]), rail: "blossom" }).then((result) => {
      element.dataset.pendingUpload = result.ok ? "unexpected-success" : "invalidated";
    });
  });
  await started;
  await page.evaluate(() => window.__platformTest?.signOut());
  releaseSigning?.();
  await expect(frame.locator("html")).toHaveAttribute("data-pending-upload", "invalidated");
  activeSecret = secondSecret;
  await page.evaluate(() => window.__platformTest?.connectExtension());
  await expect(frame.locator("html")).toHaveAttribute("data-identity-latest", getPublicKey(secondSecret));
  expect(Number(await frame.locator("html").getAttribute("data-identity-changes"))).toBeGreaterThanOrEqual(3);
});

test("rejects shell messages from an unregistered source window", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toHaveText("Platform ready");
  const receivedInit = await page.evaluate(async () => {
    const probe = document.createElement("iframe");
    probe.setAttribute("sandbox", "allow-scripts");
    probe.srcdoc = `<script>let gotInit=false;addEventListener('message',e=>{if(e.data?.type==='shell.init')gotInit=true});parent.postMessage({type:'shell.ready'},'*');setTimeout(()=>parent.postMessage({type:'probe.result',gotInit},'*'),200)</script>`;
    const result = new Promise<boolean>((resolve) => {
      const listener = (event: MessageEvent) => {
        if (event.source !== probe.contentWindow || event.data?.type !== "probe.result") return;
        window.removeEventListener("message", listener);
        resolve(Boolean(event.data.gotInit));
      };
      window.addEventListener("message", listener);
    });
    document.body.append(probe);
    const received = await result;
    probe.remove();
    return received;
  });
  expect(receivedInit).toBe(false);
});

test("reloads shell and verified Napplet while offline", async ({ page, context, browserName }) => {
  test.skip(browserName === "webkit", "Playwright WebKit offline reload is unsupported");
  await page.goto("./");
  await expect(page.locator("#status")).toHaveText("Platform ready");
  await expect(page.frameLocator("iframe").locator("#fixture-status")).toHaveText("ready");
  await page.reload();
  await expect(page.locator("#status")).toHaveText("Platform ready");
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#status")).toHaveText("Platform ready");
  await expect(page.frameLocator("iframe").locator("#fixture-status")).toHaveText("ready");
});

test("closing a Napplet removes its window and authenticated session", async ({ page }) => {
  await page.goto("./");
  await expect(page.frameLocator("iframe").locator("#fixture-status")).toHaveText("ready");
  const before = await page.evaluate(() => ({
    managed: window.__platformTest?.windows.listWindowIds() ?? [],
    authenticated: window.__platformTest?.authenticatedWindowIds() ?? []
  }));
  expect(before.managed).toHaveLength(1);
  expect(before.authenticated).toEqual(before.managed);
  await page.getByRole("button", { name: "Close Platform Fixture" }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(await page.evaluate(() => window.__platformTest?.windows.listWindowIds())).toEqual([]);
  expect(await page.evaluate(() => window.__platformTest?.authenticatedWindowIds())).toEqual([]);
});

test("coordinate loader reports malformed input without opening a window", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toHaveText("Platform ready");
  const spotlight = page.getByRole("button", { name: "Open Napplet Spotlight" });
  await spotlight.click();
  await expect(spotlight).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#coordinate")).toBeVisible();
  await page.locator("#coordinate").fill("not-a-coordinate");
  const openButton = page.getByRole("button", { name: "Open Napplet", exact: true });
  await expect(openButton).toBeEnabled();
  await openButton.click();
  await expect(page.locator("#loader-status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#loader-status")).toHaveText("Use naddr or kind:pubkey:identifier");
  await expect(page.locator("#coordinate")).toHaveValue("not-a-coordinate");
  await expect(page.locator("#windows iframe")).toHaveCount(1);
});

test("coordinate loader animates pending work", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toHaveText("Platform ready");
  await page.evaluate(() => {
    const platform = window.__platformTest as unknown as {
      installAndOpen(coordinate: string): Promise<{ dTag: string; title: string; windowId: string }>;
    };
    let opened = 0;
    platform.installAndOpen = async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      opened += 1;
      return { dTag: "animated-fixture", title: "Animated Fixture", windowId: `animated-window-${opened}` };
    };
  });
  await page.getByRole("button", { name: "Open Napplet Spotlight" }).click();
  await page.locator("#coordinate").fill("35129:fixture:animated");
  await page.getByRole("button", { name: "Open Napplet", exact: true }).click();
  await expect(page.locator("#loader-status")).toHaveAttribute("data-state", "busy");
  await expect(page.locator("#loader-progress")).toHaveCSS("opacity", "1");
  await expect(page.locator("#loader-status")).toHaveText("Opened Animated Fixture.");
  await expect(page.locator("#coordinate")).toHaveValue("");
  await expect(page.locator("#spotlight-panel")).toBeHidden();
  await page.getByRole("button", { name: "Open Napplet Spotlight" }).click();
  await page.locator("#coordinate").fill("35129:fixture:second");
  await page.getByRole("button", { name: "Open Napplet", exact: true }).click();
  await expect(page.locator("#loader-status")).toHaveText("Opened Animated Fixture.");
});

test("refresh restores open installed napplets", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toHaveText("Platform ready");
  const coordinate = await page.evaluate(async () => (await window.__platformTest?.dockLaunchers())?.find((launcher) => launcher.dTag === "problem-composer")?.coordinate);
  await page.evaluate((value) => localStorage.setItem("shell.pinned-napplets", JSON.stringify([value])), coordinate);
  await page.reload();
  await page.getByRole("button", { name: "Open Problem Composer" }).click();
  await expect(page.locator(".napplet-window")).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("shell.window-session.v2"))).not.toBeNull();

  await page.reload();
  await expect(page.locator("#status")).toHaveText("Platform ready");
  await expect(page.locator(".napplet-window")).toHaveCount(2);
});

test("refresh migrates legacy dock state without relay discovery", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toHaveText("Platform ready");
  const coordinate = await page.evaluate(async () => (await window.__platformTest?.dockLaunchers())?.find((launcher) => launcher.dTag === "problem-composer")?.coordinate);
  await page.evaluate((value) => localStorage.setItem("shell.pinned-napplets", JSON.stringify([value])), coordinate);
  await page.reload();
  await page.getByRole("button", { name: "Open Problem Composer" }).evaluate((button) => {
    button.click();
    return new Promise<string>((resolve) => {
      const poll = (): void => {
        const saved = JSON.parse(localStorage.getItem("shell.window-session.v2") ?? "null") as { windows?: { launch?: { coordinate?: string } }[] } | null;
        const coordinate = saved?.windows?.[0]?.launch?.coordinate;
        if (coordinate) resolve(coordinate);
        else setTimeout(poll, 10);
      };
      poll();
    });
  });
  await page.evaluate((savedCoordinate) => localStorage.setItem("shell.open-napplets", JSON.stringify([savedCoordinate])), coordinate);

  await page.reload();
  await expect(page.locator(".napplet-window")).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("shell.window-session.v2") ?? "null")?.windows?.[0]?.dTag)).toBe("problem-composer");
});

test("profile leads menu bar and built-in viewers open", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toBeHidden();
  const rocketViewer = page.getByRole("button", { name: "View Rockets" });
  const dagViewer = page.getByRole("button", { name: "Problem Tracker" });
  await expect(page.locator("#menu-bar .menu-cluster > button").first()).toHaveAttribute("id", "profile-menu-trigger");
  await expect(page.locator("#dock-shell")).toHaveCount(0);
  await rocketViewer.click();
  await expect(page.locator('iframe[title="nostrocket-state"]')).toHaveCount(1);
  await dagViewer.click();
  await expect(page.locator('iframe[title="navigate-problem-tree"]')).toHaveCount(1);
});

test("menu actions reuse and reveal widgets across workspaces", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toBeHidden();

  const newRocket = page.getByRole("button", { name: "New Rocket" });
  await newRocket.click();
  await expect(page.locator('iframe[title="create-rocket"]')).toHaveCount(1);
  await newRocket.click();
  await expect(page.locator('iframe[title="create-rocket"]')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("title"))).toBe("create-rocket");

  const problemTracker = page.getByRole("button", { name: "Problem Tracker" });
  await problemTracker.click();
  const tracker = page.locator('.napplet-window:has(iframe[title="navigate-problem-tree"])');
  await expect(tracker).toHaveCount(1);
  const toolbar = tracker.locator(".napplet-window-toolbar");
  await toolbar.focus();
  await toolbar.press("Space");
  await toolbar.press("ArrowDown");
  await toolbar.press("ArrowDown");
  await toolbar.press("Enter");
  await expect.poll(() => tracker.evaluate((element) => Number.parseInt((element as HTMLElement).style.gridRow, 10))).toBeGreaterThanOrEqual(3);
  const persistedRow = await tracker.evaluate((element) => (element as HTMLElement).style.gridRow);

  await page.evaluate(() => window.scrollTo(0, 0));
  await problemTracker.click();
  await expect(tracker).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("title"))).toBe("navigate-problem-tree");

  await page.reload();
  const restoredTracker = page.locator('.napplet-window:has(iframe[title="navigate-problem-tree"])');
  await expect(restoredTracker).toHaveCount(1);
  await expect.poll(() => restoredTracker.evaluate((element) => (element as HTMLElement).style.gridRow)).toBe(persistedRow);
  await expect(page.locator('iframe[title="create-rocket"]')).toHaveCount(1);
});

test("New Rocket owns a fullscreen workspace that closes cleanly", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toBeHidden();

  await page.getByRole("button", { name: "Problem Tracker" }).click();
  const tracker = page.locator('.napplet-window:has(iframe[title="navigate-problem-tree"])');
  await expect(tracker).toBeVisible();
  const trackerPlacement = await tracker.evaluate((element) => ({
    column: (element as HTMLElement).style.gridColumn,
    row: (element as HTMLElement).style.gridRow
  }));
  const previewsBefore = await page.locator("#screen-nav .screen-preview").count();

  await page.getByRole("button", { name: "New Rocket" }).click();
  const rocket = page.locator('.napplet-window:has(iframe[title="create-rocket"])');
  await expect(rocket).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect.poll(() => page.locator("#screen-nav .screen-preview").count()).toBe(previewsBefore + 1);
  const rocketPlacement = await rocket.evaluate((element) => ({
    column: (element as HTMLElement).style.gridColumn,
    row: (element as HTMLElement).style.gridRow
  }));
  expect(rocketPlacement.column).toMatch(/^1 \/ span [246]$/);
  expect(rocketPlacement.row).toMatch(/^3 \/ span 2$/);

  await page.reload();
  const restoredTracker = page.locator('.napplet-window:has(iframe[title="navigate-problem-tree"])');
  const restoredRocket = page.locator('.napplet-window:has(iframe[title="create-rocket"])');
  await expect(restoredTracker).toBeVisible();
  await expect(restoredRocket).toBeVisible();
  await expect.poll(() => restoredTracker.evaluate((element) => ({
    column: (element as HTMLElement).style.gridColumn,
    row: (element as HTMLElement).style.gridRow
  }))).toEqual(trackerPlacement);
  await expect.poll(() => restoredRocket.evaluate((element) => ({
    column: (element as HTMLElement).style.gridColumn,
    row: (element as HTMLElement).style.gridRow
  }))).toEqual(rocketPlacement);

  await restoredRocket.getByRole("button", { name: "Close Create Rocket" }).click();
  await expect(restoredRocket).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect.poll(() => page.locator("#screen-nav .screen-preview").count()).toBe(previewsBefore);
  await expect(restoredTracker).toBeVisible();
  await expect.poll(() => restoredTracker.evaluate((element) => ({
    column: (element as HTMLElement).style.gridColumn,
    row: (element as HTMLElement).style.gridRow
  }))).toEqual(trackerPlacement);

  await page.reload();
  await expect(page.locator('iframe[title="create-rocket"]')).toHaveCount(0);
  await expect(page.locator('iframe[title="navigate-problem-tree"]').locator("..")).toBeVisible();
  await expect.poll(() => page.locator('.napplet-window:has(iframe[title="navigate-problem-tree"])').evaluate((element) => ({
    column: (element as HTMLElement).style.gridColumn,
    row: (element as HTMLElement).style.gridRow
  }))).toEqual(trackerPlacement);
});

test("hard reset lives in Napplet console instead of menu bar", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toBeHidden();
  await expect(page.locator("#menu-bar #hard-reset-trigger")).toHaveCount(0);
  await page.getByRole("button", { name: "Open Napplet console" }).click();
  const reset = page.locator("#napplet-console-panel #hard-reset-trigger");
  await expect(reset).toBeVisible();
  await expect(reset).toHaveAttribute("title", "Hard reset shell cache");
});

test("menu bar exposes account and Spotlight controls", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toBeHidden();
  const profile = page.locator("#profile-menu-trigger");
  await expect(profile.locator("#profile-avatar-fallback")).toHaveText("R");
  await profile.click();
  await expect(page.locator("#profile-menu-label")).toHaveText("ephemeral");
  await profile.click();
  await expect(page.locator("#account-popover")).toBeVisible();
  await expect(page.getByRole("button", { name: "Profile (coming soon)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#account-popover")).toBeHidden();
  const spotlight = page.getByRole("button", { name: "Open Napplet Spotlight" });
  await spotlight.click();
  await expect(page.locator("#spotlight-panel")).toBeVisible();
  await expect(page.locator("#coordinate")).toBeVisible();
  await spotlight.click();
  await expect(page.locator("#spotlight-panel")).toBeHidden();
});

test("profile icon prefers NIP-07 when extension is available", async ({ page }) => {
  const pubkey = "1".repeat(64);
  await page.addInitScript((value) => {
    Object.defineProperty(window, "nostr", { configurable: true, value: { getPublicKey: async () => value } });
  }, pubkey);
  await page.goto("./");
  await expect(page.locator("#status")).toBeHidden();
  await page.locator("#profile-menu-trigger").click();
  await expect(page.locator("#profile-menu-label")).toHaveText("11111111…");
});

test("relay status opens an accessible connected-relays popover", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toHaveText("Platform ready");
  const trigger = page.locator("#relay-status");
  await expect(trigger).toHaveAttribute("aria-controls", "relay-popover");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("region", { name: "Connected relays" })).toBeVisible();
  await expect(page.locator("#relay-popover-empty")).toHaveText("No relays currently connected.");

  await page.getByRole("button", { name: "Open Napplet Spotlight" }).click();
  await expect(page.locator("#relay-popover")).toBeHidden();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#relay-popover")).toBeHidden();

  await trigger.click();
  await page.locator("main").click({ position: { x: 4, y: 4 } });
  await expect(page.locator("#relay-popover")).toBeHidden();
});

test("preferences panel themes the shell and edits the local relay list", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("#status")).toBeHidden();
  await page.locator("#profile-menu-trigger").click();
  await expect(page.locator("#profile-menu-label")).toHaveText("ephemeral");
  await page.locator("#profile-menu-trigger").click();
  await page.getByRole("button", { name: "Preferences" }).click();
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.locator("#account-popover")).toBeHidden();

  await expect(page.getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("tab", { name: "Relays" }).click();
  await expect(page.getByText("Connect an identity to see and edit this list.")).toBeVisible();
  const backup = page.getByLabel("Add to backup relays");
  await backup.fill("http://insecure.example.com");
  await backup.press("Enter");
  await expect(page.getByText("Relay scheme forbidden")).toBeVisible();
  await backup.fill("wss://added.example.com");
  await backup.press("Enter");
  await expect(page.getByText("wss://added.example.com/", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-panel")).toBeHidden();

  // Both the theme and the relay edit are persisted, not just held in memory.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#profile-menu-trigger").click();
  await expect(page.locator("#profile-menu-label")).toHaveText("ephemeral");
  await page.locator("#profile-menu-trigger").click();
  await page.getByRole("button", { name: "Preferences" }).click();
  await page.getByRole("tab", { name: "Relays" }).click();
  await expect(page.getByText("wss://added.example.com/", { exact: true })).toBeVisible();
});

test("edits new-problem Markdown inside packaged sandbox", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("platform:settings:v1", JSON.stringify({ backupBlossomServers: ["http://127.0.0.1:4173/mock-blossom"] }));
  });
  const secret = new Uint8Array(32); secret[31] = 12;
  const pubkey = getPublicKey(secret);
  await page.exposeFunction("__platformTestSignProblem", (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, secret));
  await page.addInitScript((activePubkey) => {
    Object.defineProperty(window, "nostr", { value: {
      getPublicKey: async () => activePubkey,
      signEvent: (template: { kind: number; created_at: number; content: string; tags: string[][] }) =>
        (window as unknown as { __platformTestSignProblem(value: typeof template): Promise<unknown> }).__platformTestSignProblem(template)
    }, configurable: true });
  }, pubkey);

  await page.goto("./");
  await expect(page.getByRole("button", { name: "Open Problem Composer" })).toBeVisible();
  await page.evaluate(() => window.__platformTest?.connectExtension());
  await page.getByRole("button", { name: "Open Problem Composer" }).click();
  const iframe = page.locator('iframe[title="problem-composer"]');
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  const frame = page.frameLocator('iframe[title="problem-composer"]');
  await expect(frame.getByRole("toolbar", { name: "Markdown formatting" })).toBeVisible();
  const boldButton = frame.getByRole("button", { name: "Bold" });
  await expect(boldButton).toBeEnabled();
  await expect(boldButton).toHaveCSS("width", "36px");
  await expect(boldButton).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(boldButton.locator("svg")).toHaveCSS("width", "18px");
  await expect(boldButton.locator("svg")).toHaveCSS("stroke-width", "1.8px");
  await expect(frame.locator("form")).toHaveCount(0);

  await boldButton.click();
  await expect(frame.locator("#count")).not.toHaveText("0");
  const content = frame.locator(".cm-content");
  await expect(content).toContainText("**bold text**");
  await expect(content.locator(".cm-strong")).toHaveText("**bold text**");
  await expect(content.locator(".cm-strong")).toHaveCSS("font-weight", "700");
  await content.click();
  await content.press("End");
  await content.press("Enter");
  await content.pressSequentially("second line");
  await expect(frame.locator(".cm-line")).toHaveCount(2);

  await frame.locator("#attachment").setInputFiles({ name: "proof.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  await expect(frame.locator("#attachment-status")).toContainText("proof.png added to description");
  await expect(frame.locator("#count")).not.toHaveText("0");

  await content.press("Control+Enter");
  await expect(frame.locator("#status-line")).toHaveText("Add a problem title.");
  expect(browserErrors.filter((message) => /allow-forms|form submission/i.test(message))).toEqual([]);

  await page.setViewportSize({ width: 320, height: 720 });
  await expect.poll(() => frame.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});
