import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        dashboard: resolve(__dirname, "dashboard.html"),
        popup: resolve(__dirname, "popup.html")
      }
    }
  },
  server: {
    port: 5173,
    open: true
  }
});
