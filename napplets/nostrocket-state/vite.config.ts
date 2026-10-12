import { nip5aManifest } from "@napplet/vite-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [nip5aManifest({
    nappletType: "nostrocket-state",
    title: "NOSTROCKET State",
    description: "Current NOSTROCKET merit holdings and Microsubjective Blockchain state.",
    requires: ["outbox", "resource", "inc"],
    archetypes: [{ slug: "rocket", convention: "napplet:rocket/open" }],
    artifactMode: "single-file"
  })],
  build: { modulePreload: false },
  test: { environment: "node" }
});
