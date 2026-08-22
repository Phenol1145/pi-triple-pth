import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // 仓内 workspace 包测试始终跑源码（无需先 build）。
      "@away_from/pth-contracts": fileURLToPath(new URL("./packages/pth-contracts/src/index.ts", import.meta.url)),
      "@away_from/pth-config": fileURLToPath(new URL("./packages/pth-config/src/index.ts", import.meta.url)),
      "@away_from/pth-kernel-storage": fileURLToPath(new URL("./packages/pth-kernel-storage/src/index.ts", import.meta.url)),
      "@away_from/pth-kernel-interpreter": fileURLToPath(new URL("./packages/pth-kernel-interpreter/src/index.ts", import.meta.url)),
      "@away_from/pth-kernel-execution": fileURLToPath(new URL("./packages/pth-kernel-execution/src/index.ts", import.meta.url)),
      "@away_from/pth-memory": fileURLToPath(new URL("./packages/pth-memory/src/index.ts", import.meta.url)),
      "@away_from/pth-sandbox": fileURLToPath(new URL("./packages/pth-sandbox/src/index.ts", import.meta.url)),
      "@away_from/pth-console": fileURLToPath(new URL("./packages/pth-console/src/index.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx", "packages/*/test/**/*.test.ts"],
    testTimeout: 90_000,
    // testcontainers 并发资源竞争（Docker Desktop 多 postgres 并发启动超时）——
    // 实测 maxWorkers=4 稳定全绿；并发过高时 testcontainers 偶发启动失败
    maxWorkers: 4,
    poolOptions: {
      maxWorkers: 4,
    },
    server: {
      deps: {
        // 强制内联 npm 包（shared/infra 是已发布 dist，不内联时其内部 SDK import
        // 绕过 Vite mock 管线，导致 vi.mock("@earendil-works/pi-coding-agent") 失效）。
        inline: [/@away_from\/(infra|shared)/],
      },
    },
  },
});
