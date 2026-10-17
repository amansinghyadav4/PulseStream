import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy forwards /api to the PulseStream API so the browser stays
// same-origin (production nginx container does the same thing).
// Override target with PULSESTREAM_API_TARGET if your API lives elsewhere.
const apiTarget = process.env.PULSESTREAM_API_TARGET ?? "http://localhost:8001";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    proxy: {
      "/api": apiTarget,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
