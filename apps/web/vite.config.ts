import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.PLAYON_WEB_HOST ?? "127.0.0.1",
    port: Number(process.env.PLAYON_WEB_PORT ?? 5173),
    proxy: {
      "/api": {
        target: process.env.PLAYON_API_PROXY ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});

