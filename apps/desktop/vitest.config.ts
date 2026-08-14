import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    // Heavy jsdom suites become timing-sensitive when every test file starts at once.
    maxWorkers: 2,
    // CI runners are slow enough that heavy App suites overrun the 5s default.
    testTimeout: 20000,
  },
});
