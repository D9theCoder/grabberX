import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Electron shell runs .next/standalone/server.js with its own Node, so the packaged app needs no node_modules.
  output: "standalone",
  // The repo root is also the media root. Keep the output file tracer out of the account folders.
  outputFileTracingExcludes: {
    "*": ["./*/Image/**", "./*/Video/**", "./**/*.sqlite3", "./.gather/**", "./src/**", "./docs/**", "./e2e/**"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
