import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [preact()],
  build: { outDir: "../../dist/web", emptyOutDir: true, target: "es2022" },
  server: { proxy: { "/api": "http://127.0.0.1:8787", "/auth": "http://127.0.0.1:8787" } },
});
