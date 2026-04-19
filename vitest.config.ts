import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000, // 30s for onchain reads
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
})
