import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [
      ".next/**",
      "out/**",
      // Throwaway worktrees carry their own build output; sweeping them
      // buries the run in tens of thousands of build-artifact findings.
      ".worktrees/**",
      ".claude/worktrees/**",
      "node_modules/**",
      "next-env.d.ts",
      // Documents and their evidence are not application code.
      "docs/**",
      // A version-parity tested upstream executable: lint our wrapper, not
      // the byte-identical loaders.gl distribution it wraps.
      "public/workers/**",
    ],
  },
];

export default eslintConfig;
