import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

/**
 * 两种构建（产物差异见 BUILDING §4 与 README 下载表）：
 *   npm run build         → 现代包 dist/（es2022）：WebView / Chromium 80+ 使用
 *   npm run build:compat  → 兼容包 dist-compat/：额外产出 nomodule 的 ES5 legacy 包 + polyfills，
 *                           老内核（Chromium 61+）由 @vitejs/plugin-legacy 的现代性探测脚本自动加载
 */
export default defineConfig(({ mode }) => {
  const compat = mode === "compat";
  return {
    plugins: [
      react(),
      ...(compat
        ? [legacy({
            // 老内核下限：Chromium 61（原生支持 <script type="module"> 的起点）
            targets: ["chrome >= 61", "android >= 7", "safari >= 12"],
            // 现代包不加 polyfill（体积优先）；legacy 包自带 core-js
            modernPolyfills: false
          })]
        : [])
    ],
    server: {
      host: "0.0.0.0",
      port: 5173,
      // 别去 watch 这些目录：_archive 里有浏览器 profile（锁文件会让 watcher 抛 EBUSY 把 dev server 打挂），
      // release/release-pc 是几百 MB 的打包产物，watch 它们纯属浪费 IO
      watch: { ignored: ["**/_archive/**", "**/release/**", "**/release-pc/**", "**/android/app/build/**", "**/dist/**", "**/dist-compat/**"] }
    },
    build: {
      target: "es2022",
      outDir: compat ? "dist-compat" : "dist",
      emptyOutDir: true
    },
    // 构建时从 package.json 读取版本，注入前端常量（构建产物中 LOCAL_VERSION 始终与 package.json 一致）
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    }
  };
});
