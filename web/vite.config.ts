import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { aliases } from "../packages/aliases.mjs";

export default defineConfig({
  root: "web",
  resolve: { alias: aliases },
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    // The editor's fonts keep fixed addresses, /fonts/<Family>/<file>, which our styles and pages use too.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
    rollupOptions: {
      output: {
        assetFileNames: (asset) => {
          const name = asset.names?.[0] ?? "";
          return name.endsWith(".woff2") ? `fonts/${name.split("-")[0]}/[name][extname]` : "assets/[name]-[hash][extname]";
        },
      },
    },
  },
  server: {
    port: 5173,
    // Targets as objects, not strings: for a string Vite rewrites Host, and the server refuses writes whose Origin
    // matches neither Host nor BASE_URL. Agent links and the MCP address may point here too.
    proxy: {
      "/api": { target: "http://127.0.0.1:3000" },
      "/agent/": { target: "http://127.0.0.1:3000" },
      "/mcp": { target: "http://127.0.0.1:3000" },
      "/ws": { target: "ws://127.0.0.1:3000", ws: true },
    },
  },
});
