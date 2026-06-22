import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react()
  ],
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three") || id.includes("node_modules\\three")) return "three";
          if (id.includes("node_modules")) return "vendor";
          return undefined;
        }
      }
    }
  },
  server: {
    proxy: {
      "/api": "http://localhost:4000"
    }
  }
});
