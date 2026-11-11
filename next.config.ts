import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo root is also the media root. Keep the output file tracer out of the account folders.
  outputFileTracingExcludes: {
    "*": ["./*/Image/**", "./*/Video/**", "./**/*.sqlite3"],
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
