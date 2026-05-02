import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "spec-pipeline/**", "paperclip-demo-target/**", "demo-app/**"],
  },
});
