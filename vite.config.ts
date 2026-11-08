import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Keep Vite output out of dist/ — tinyjs build writes the Windows portable
// package (yt-feed.exe + launcher.exe + frontend/) into dist/.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'web-dist',
    emptyOutDir: true,
  },
})
