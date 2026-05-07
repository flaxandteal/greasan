import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    wasm(),
  ],
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: ['alizarin', 'ros-madair'],
  },
  server: {
    watch: {
      // Avoid exhausting inotify watchers on large directories
      ignored: ['**/android/**', '**/ios/**', '**/node_modules/**'],
    },
  },
})
