/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only API server port (see server/index.ts). In production the same
// Node server serves both the built frontend and the API on one port.
const API_TARGET = process.env.API_TARGET ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on 0.0.0.0 so the dev server works inside Docker too
    port: 5173,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
      // Forward the live-updates WebSocket to the API server.
      "/ws": {
        target: API_TARGET,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        test: new URL("./test.html", import.meta.url).pathname,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    css: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}", "server/**/*.{test,spec}.ts"],
  },
});
