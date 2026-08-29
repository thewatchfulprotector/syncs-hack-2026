import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sourceDir = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": sourceDir,
    },
  },
});
