import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // public/sw.js is a browser service worker (service-worker globals), so it is not linted as Node code.
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/*.config.*",
      "**/next-env.d.ts",
      "apps/web/public/sw.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
);
