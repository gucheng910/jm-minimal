import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig({
  // 与 vite.config.ts 保持一致：constants.ts 的 LOCAL_VERSION 依赖这个注入
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    // 默认 node 环境；需要 DOM 的用例在文件顶部写 // @vitest-environment jsdom
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true
  }
});
