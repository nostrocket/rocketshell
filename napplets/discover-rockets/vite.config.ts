import { nip5aManifest } from "@napplet/vite-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [nip5aManifest({
    nappletType: "discover-rockets",
    title: "Discover Rockets",
    description: "Discover and visualize every Sovereign Economic Community rocket and its multi-root hierarchy.",
    requires: ["outbox"],
    artifactMode: "single-file"
  })],
  build: { modulePreload: false },
  test: { environment: "node" }
});
