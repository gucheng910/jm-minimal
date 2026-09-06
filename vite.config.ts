import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig({
  plugins: [react()],
  server: { host: "0.0.0.0", port: 5173 },
  build: { target: "es2022" },
  // 构建时从 package.json 读取版本，注入前端常量（构建产物中 LOCAL_VERSION 始终与 package.json 一致）
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  }
});
