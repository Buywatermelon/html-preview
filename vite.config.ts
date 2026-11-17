import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/client"),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, "frontend/src/main.tsx"),
      output: {
        entryFileNames: "client.js",
        chunkFileNames: "client-[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) return "client.css";
          return "assets/[name][extname]";
        },
        codeSplitting: false,
      },
    },
  },
});
