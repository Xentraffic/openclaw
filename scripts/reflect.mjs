#!/usr/bin/env node
/**
 * Standalone reflect runner.
 * Usage: node scripts/reflect.mjs [--force] [--skip-synthesis]
 *
 * Runs the full reflect pipeline (opinion updates, entity pages, weekly synthesis).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve workspace from env or default
const workspaceDir =
  process.env.OPENCLAW_WORKSPACE ||
  path.join(process.env.HOME || "/home/xenhive", ".openclaw", "workspace");

const args = new Set(process.argv.slice(2));

async function main() {
  // Dynamic import from the dist
  const distDir = path.join(__dirname, "..", "dist");

  // Import the reflect runner
  const { runReflect } = await import(path.join(distDir, "index.js"))
    .then(async () => {
      // The reflect runner is bundled, try direct import
      return import("../dist/reflect-runner.js").catch(() => {
        // Fallback: import from source
        return import("../src/memory/bank/reflect-runner.js");
      });
    })
    .catch(async () => {
      // Direct import approach
      return import("../src/memory/bank/reflect-runner.js");
    });

  const force = args.has("--force");
  const skipSynthesis = args.has("--skip-synthesis");

  console.log("=== OpenClaw Reflect ===");
  console.log(`Workspace: ${workspaceDir}`);
  console.log(`Options: force=${force}, skipSynthesis=${skipSynthesis}`);
  console.log("");

  const result = await runReflect({
    workspaceDir,
    force,
    skipSynthesis,
  });

  if (result.skipped) {
    console.log(`⏭️  ${result.skipReason}`);
  }

  console.log("");
  console.log(`Total duration: ${result.durationMs}ms`);
}

main().catch((err) => {
  console.error("❌ Reflect failed:", err);
  process.exitCode = 1;
});
