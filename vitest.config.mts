import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // `server-only` throws outside the Next.js server bundle, so tests swap in an empty module.
      "server-only": src("test/server-only.ts"),
      "@": src(""),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
