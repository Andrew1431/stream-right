import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri loads the dev server on this fixed port (see src-tauri/tauri.conf.json).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
});
