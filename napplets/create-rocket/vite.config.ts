import { nip5aManifest } from "@napplet/vite-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [nip5aManifest({
    nappletType: "create-rocket",
    title: "Create Rocket",
    description: "Create and publish a Sovereign Economic Community ignition event.",
    requires: ["outbox", "identity", "resource"],
    artifactMode: "single-file"
  })],
  build: { modulePreload: false },
  test: { environment: "node" }
});
