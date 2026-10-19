import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [preact()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        // Preact and the shared app helpers in one chunk next to the entry, so the
        // first page loads two scripts however many pages load on demand.
        manualChunks: (id) =>
          id.includes("/node_modules/") ||
          /\/src\/web\/lib\/(api|state|router|lazy|live|format|categories)\.ts$/.test(id)
            ? "base"
            : undefined,
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:8787", "/auth": "http://127.0.0.1:8787" } },
});
