import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  // Shown at the foot of the Projects screen so it's obvious whether a
  // phone has picked up the latest deploy.
  define: {
    __BUILD_STAMP__: JSON.stringify(
      new Date().toLocaleString("en-US", {
        timeZone: "America/Phoenix",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    ),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Only precache the app shell (JS/CSS/HTML) up front — this is what
      // makes the install step fast. Recordings and photos are handled by
      // our own IndexedDB queue in src/offline, not this cache — media
      // never touches the service worker cache.
      //
      // Two things intentionally do NOT go in the precache manifest, both
      // fetched (and then cached) lazily on first use instead:
      //  - the Whisper MODEL WEIGHTS (~70MB): fetched from the Hugging Face
      //    CDN and cached by @huggingface/transformers itself.
      //  - the onnxruntime-web WASM runtime bundled here (~21MB, the SIMD
      //    threaded build) — too large to force into the install step, so
      //    it's cached at runtime instead (see runtimeCaching below).
      // Both need one connection to download the first time; after that,
      // every walkthrough transcribes fully offline.
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        runtimeCaching: [
          // Homebuilder Ops' fonts, kept on the phone so the app looks the
          // same with no signal.
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/,
            handler: "CacheFirst",
            options: {
              cacheName: "fonts",
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\.wasm$/,
            handler: "CacheFirst",
            options: {
              cacheName: "onnxruntime-wasm",
              expiration: { maxEntries: 4 },
            },
          },
        ],
      },
      manifest: {
        name: "Punch List",
        short_name: "Punch List",
        description:
          "Record a job site walkthrough, snap photos, get a photo-backed punch list.",
        theme_color: "#f4f2ea",
        background_color: "#f4f2ea",
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
  // whisper.worker.ts is loaded as `new Worker(url, { type: "module" })" —
  // needs Vite's ES-module worker output (the default "iife" format can't
  // handle the dynamic imports @huggingface/transformers uses internally).
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // Has its own WASM/ONNX-runtime loading that Vite's dep pre-bundler
    // mishandles — let it load natively instead.
    exclude: ["@huggingface/transformers"],
  },
});
