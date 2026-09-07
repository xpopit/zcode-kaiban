import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy /api to the Bun server so the frontend never needs CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4310",
        changeOrigin: true,
      },
    },
  },
});
