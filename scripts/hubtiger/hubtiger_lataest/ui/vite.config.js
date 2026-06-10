import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // During dev, proxy to your server-side hubtiger-proxy if desired.
  // In prod behind Caddy, you’ll just call relative /admin/api/hubtiger/...
  server: {
    proxy: {
      "/admin/api/hubtiger": "http://localhost:8080"
    }
  }
});
