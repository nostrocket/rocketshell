/*
  Problem Composer — one napplet, two intent modes.

  The manifest advertises the `composer` archetype for both
  `napplet:composer/problem-child` and `napplet:composer/problem-edit`. NAP-INTENT
  is N:M, so the shell routes either convention to this dTag; this router picks
  the mode from the delivered convention and reuses one window. Callers keep
  naming the convention and payload they always did — nothing outside changes.
*/
import { identity, inc, type Subscription } from "@napplet/sdk";
import "@platform/napplet-markdown-editor/styles.css";
import "./styles.css";
import { CHILD_CONVENTION } from "./compose";
import { EDIT_CONVENTION } from "./revise";
import { isProblemIdPayload } from "./problem";
import { mountComposeView } from "./compose-view";
import { mountReviseView } from "./revise-view";
import type { AppContext } from "./context";

const appRoot = document.querySelector<HTMLElement>("#app");
if (!appRoot) throw new Error("Application root is missing.");
const app: HTMLElement = appRoot;

let pubkey = "";
const identityListeners = new Set<(pubkey: string) => void>();

const context: AppContext = {
  root: app,
  getPubkey: () => pubkey,
  onIdentityChanged: (listener) => {
    identityListeners.add(listener);
    return () => { identityListeners.delete(listener); };
  }
};

let disposeActive: (() => void) | undefined;
let identitySubscription: Subscription | undefined;
const intentSubscriptions: Subscription[] = [];

function mountMode(className: "mode-compose" | "mode-revise"): HTMLElement {
  disposeActive?.();
  disposeActive = undefined;
  const container = document.createElement("div");
  container.className = className;
  app.replaceChildren(container);
  return container;
}

/** Genesis mode. No parent id means a graph-root problem. */
function showCompose(parentId?: string): void {
  const container = mountMode("mode-compose");
  disposeActive = mountComposeView(container, context, parentId);
}

/** Revision mode for one problem id. */
function showRevise(problemId: string): void {
  const container = mountMode("mode-revise");
  disposeActive = mountReviseView(container, context, problemId);
}

function notifyIdentity(next: string): void {
  pubkey = next;
  for (const listener of [...identityListeners]) listener(next);
}

async function start(): Promise<void> {
  // Register handlers before any await: the shell delivers a cold-start intent
  // as soon as the iframe reports ready, while identity may still be pending.
  try {
    intentSubscriptions.push(inc.on(CHILD_CONVENTION, (event) => {
      if (!isProblemIdPayload(event.payload)) {
        console.warn("Problem child intent rejected an invalid payload", { sender: event.sender });
        return;
      }
      showCompose(event.payload.problemId);
    }));
    intentSubscriptions.push(inc.on(EDIT_CONVENTION, (event) => {
      if (!isProblemIdPayload(event.payload)) {
        console.warn("Problem edit intent rejected an invalid payload", { sender: event.sender });
        return;
      }
      showRevise(event.payload.problemId);
    }));
  } catch (error) {
    console.error("Problem composer intent subscription failed", { error });
  }

  // Default mode when opened directly: compose a graph-root problem.
  showCompose();

  try {
    notifyIdentity((await identity.getPublicKey()) ?? "");
  } catch (error) {
    console.error("Shell identity initialization failed", { error });
  }
  try {
    identitySubscription = identity.onChanged((next) => notifyIdentity(next ?? ""));
  } catch (error) {
    console.warn("Shell identity change subscription failed; sign-in changes will not be reflected", { error });
  }
}

addEventListener("beforeunload", () => {
  disposeActive?.();
  identitySubscription?.close();
  for (const subscription of intentSubscriptions) subscription.close();
});

void start();
