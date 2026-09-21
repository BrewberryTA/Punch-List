import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Only precache the app shell (JS/CSS/HTML). Recordings and photos are
      // handled by our own IndexedDB queue in src/offline, not the service
      // worker cache — media never touches the SW cache.
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
      },
      manifest: {
        name: "Punch List",
        short_name: "Punch List",
        description:
          "Record a job site walkthrough, snap photos, get a photo-backed punch list.",
        theme_color: "#111827",
        background_color: "#111827",
        display: "standalone",
        // SVG icon so it can ship as plain text in git — swap in real PNG
        // icons (192x192, 512x512, plus a maskable variant) before shipping
        // to real users; iOS home-screen icons in particular expect PNG.
        icons: [
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      "/api": "http://localhost:4000",
      "/uploads": "http://localhost:4000",
    },
  },
});
