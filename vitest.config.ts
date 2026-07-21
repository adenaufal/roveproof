import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(repositoryRoot, "apps", "target", "src"),
      "@roveproof/contracts": path.join(repositoryRoot, "packages", "contracts", "src", "index.ts"),
      "@roveproof/evidence": path.join(repositoryRoot, "packages", "evidence", "src", "index.ts"),
      "@roveproof/model-adapter": path.join(repositoryRoot, "packages", "model-adapter", "src", "index.ts"),
      "@roveproof/orchestrator": path.join(repositoryRoot, "packages", "orchestrator", "src", "index.ts"),
      "@roveproof/sandbox": path.join(repositoryRoot, "packages", "sandbox", "src", "index.ts"),
      "@roveproof/store": path.join(repositoryRoot, "packages", "store", "src", "index.ts"),
    },
  },
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 15_000,
    // Windows file replacement and fixture workers are intentionally serialized;
    // concurrency is exercised inside their dedicated lease tests.
    pool: "forks",
    maxWorkers: 1,
  },
});
