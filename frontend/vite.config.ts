import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

const cesiumBuildRootPath = path.resolve(__dirname, "../node_modules/cesium/Build");
const cesiumBuildPath = path.resolve(cesiumBuildRootPath, "Cesium");

export default defineConfig({
  plugins: [
    react(),
    cesium({
      cesiumBuildRootPath,
      cesiumBuildPath
    })
  ],
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/cesium") || id.includes("node_modules\\cesium")) return "cesium";
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
