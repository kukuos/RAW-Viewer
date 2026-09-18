// 静态资源使用相对路径(base: './'),以便部署到 GitHub Pages 子路径(仓库名路径)时 worker/wasm 相对解析仍可用
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': import.meta.dirname + '/src',
    },
  },
})
