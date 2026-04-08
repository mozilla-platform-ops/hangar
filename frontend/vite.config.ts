import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  optimizeDeps: {
    include: ["@novnc/novnc/lib/rfb.js"],
  },
  server: {
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true, ws: true },
    },
  },
})
