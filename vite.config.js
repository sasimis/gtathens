import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    inlineCss: false,

    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        driving: resolve(__dirname, 'driving.html'),
      },
    },
  },
})
