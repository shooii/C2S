import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import {
  validateWebGPUExternalImageEsbuild,
  validateWebGPUExternalImagePlugin
} from "./vite/validateWebGPUExternalImage";

export default defineConfig({
  plugins: [
    validateWebGPUExternalImagePlugin(),
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
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        validateWebGPUExternalImageEsbuild
      ]
    }
  }
});
