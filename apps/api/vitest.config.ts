import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@chi-shen-me/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    environment: "node",
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});
