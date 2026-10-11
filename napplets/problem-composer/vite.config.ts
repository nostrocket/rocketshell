import { nip5aManifest } from "@napplet/vite-plugin";
import { defineConfig } from "vitest/config";

/*
  One napplet, two composer conventions. NAP-INTENT is N:M: a single package may
  fulfil several archetype roles, and the shell's catalog keys manifest
  archetype tags by slug, so both `composer` conventions resolve to this dTag.
  `src/main.ts` routes each delivered convention to a mode.
*/
export default defineConfig({
  base: "./",
  resolve: { conditions: ["source"] },
  plugins: [
    nip5aManifest({
      nappletType: "problem-composer",
      title: "Problem Composer",
      description: "Create, edit, and publish NIP-1971 problem records.",
      requires: ["identity", "outbox", "inc", "intent", "upload"],
      archetypes: [
        { slug: "composer", convention: "napplet:composer/problem-child" },
        { slug: "composer", convention: "napplet:composer/problem-edit" }
      ],
      artifactMode: "single-file"
    })
  ],
  build: { modulePreload: false },
  test: { environment: "node", include: ["src/**/*.test.ts"] }
});
