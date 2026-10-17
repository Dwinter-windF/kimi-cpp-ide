import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { cppIdePlugin } from './dev-server'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react(), cppIdePlugin()],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 仅追加代码分割：把体积大且版本稳定的第三方库拆成独立 chunk，
        // 避免所有依赖挤进唯一的入口 JS chunk（原 833.8 kB，超过 vite 500 kB 警告线）。
        manualChunks(id: string): string | undefined {
          const p = id.replace(/\\/g, "/");
          if (!p.includes("/node_modules/")) return undefined;
          // React 运行时（react / react-dom / scheduler）
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(p)) return "react-vendor";
          // CodeMirror 6 系（@codemirror/*、@lezer/*、@uiw/react-codemirror 及其 @uiw 依赖、codemirror）
          if (/\/node_modules\/(@codemirror|@lezer|@uiw)\//.test(p)) return "codemirror";
          if (p.includes("/node_modules/codemirror/")) return "codemirror";
          // 图标库（lucide-react）
          if (p.includes("/node_modules/lucide-react/")) return "icons";
          return undefined;
        },
      },
    },
  },
});
