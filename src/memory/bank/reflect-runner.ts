/**
 * Reflect Runner — orchestrates the full reflect pipeline.
 *
 * Runs in order:
 *   1. Opinion confidence updates (reflect.ts)
 *   2. Entity page generation (reflect-entities.ts)
 *   3. Weekly synthesis (reflect-synthesis.ts) — only on Sundays or --force
 *
 * Debounces: skips if last_reflect was < 6 hours ago (unless --force).
 *
 * CLI: `openclaw reflect [--force]`
 */

import { BankIndexStore } from "./index-store.js";
import { reflectEntities, type ReflectEntitiesResult } from "./reflect-entities.js";
import { reflectSynthesis, type ReflectSynthesisResult } from "./reflect-synthesis.js";
import { reflectOpinions, type ReflectOpinionResult } from "./reflect.js";
import { ingestRetainFacts } from "./retain-ingest.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ReflectRunnerOptions = {
  /** Agent workspace directory (e.g. ~/.openclaw/workspace). */
  workspaceDir: string;
  /** Force run even if recently reflected. */
  force?: boolean;
  /** Skip weekly synthesis even if it's Sunday. */
  skipSynthesis?: boolean;
  /** Log output callback (default: console.log). */
  log?: (msg: string) => void;
};

export type ReflectRunnerResult = {
  /** Whether the run was skipped due to debounce. */
  skipped: boolean;
  /** Reason for skipping (if skipped). */
  skipReason?: string;
  /** Opinion update results (if run). */
  opinions?: ReflectOpinionResult;
  /** Entity page results (if run). */
  entities?: ReflectEntitiesResult;
  /** Weekly synthesis results (if run). */
  synthesis?: ReflectSynthesisResult;
  /** Total duration in ms. */
  durationMs: number;
};

const DEBOUNCE_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Run the full reflect pipeline.
 */
export async function runReflect(opts: ReflectRunnerOptions): Promise<ReflectRunnerResult> {
  const start = Date.now();
  const log = opts.log ?? console.log;

  const store = BankIndexStore.open(opts.workspaceDir);

  try {
    // --- Debounce check ---
    if (!opts.force) {
      const lastReflect = store.getMeta("last_reflect");
      if (lastReflect) {
        const elapsed = Date.now() - parseInt(lastReflect, 10);
        if (elapsed < DEBOUNCE_MS) {
          const hoursAgo = (elapsed / 3600000).toFixed(1);
          return {
            skipped: true,
            skipReason: `Last reflect was ${hoursAgo}h ago (debounce: 6h). Use --force to override.`,
            durationMs: Date.now() - start,
          };
        }
      }
    }

    // --- Step 0: Ensure ingest is fresh ---
    log("🔄 Ensuring Bank index is up-to-date...");
    const ingestResult = await ingestRetainFacts(opts.workspaceDir, store);
    if (ingestResult.filesChanged > 0) {
      log(
        `   ↳ Ingested ${ingestResult.factsUpserted} facts from ${ingestResult.filesChanged} files`,
      );
    } else {
      log("   ↳ Index is current");
    }

    // --- Step 1: Opinion confidence updates ---
    log("💭 Updating opinion confidence scores...");
    const opinionResult = reflectOpinions(store);
    log(
      `   ↳ ${opinionResult.opinionsProcessed} opinions processed, ${opinionResult.opinionsUpdated} updated (${opinionResult.durationMs}ms)`,
    );

    // --- Step 2: Entity page generation ---
    log("📄 Generating entity pages...");
    const entityResult = await reflectEntities(opts.workspaceDir, store);
    log(
      `   ↳ ${entityResult.entitiesProcessed} entities processed, ${entityResult.pagesUpdated} pages updated (${entityResult.durationMs}ms)`,
    );

    // --- Step 3: Weekly synthesis (Sunday only, or forced) ---
    let synthesisResult: ReflectSynthesisResult | undefined;
    const isSunday = new Date().getUTCDay() === 0;

    if (!opts.skipSynthesis && (isSunday || opts.force)) {
      log("📊 Generating weekly synthesis...");
      synthesisResult = await reflectSynthesis(opts.workspaceDir, store, {
        force: opts.force,
      });
      if (synthesisResult.written) {
        log(
          `   ↳ ${synthesisResult.weekId}: ${synthesisResult.factsAnalyzed} facts → ${synthesisResult.summaryFactsCreated} summaries (${synthesisResult.durationMs}ms)`,
        );
      } else {
        log(`   ↳ ${synthesisResult.weekId}: already generated`);
      }
    } else if (!opts.skipSynthesis) {
      log("📊 Weekly synthesis: skipped (runs on Sundays)");
    }

    // --- Record last_reflect ---
    store.setMeta("last_reflect", String(Date.now()));

    const totalMs = Date.now() - start;
    log(`✅ Reflect complete in ${totalMs}ms`);

    return {
      skipped: false,
      opinions: opinionResult,
      entities: entityResult,
      synthesis: synthesisResult,
      durationMs: totalMs,
    };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Parse CLI args and run reflect. Intended to be called from the
 * OpenClaw CLI dispatcher.
 *
 * Usage: openclaw reflect [--force] [--skip-synthesis]
 */
export async function reflectCli(args: string[], workspaceDir: string): Promise<void> {
  const force = args.includes("--force");
  const skipSynthesis = args.includes("--skip-synthesis");

  console.log("=== OpenClaw Reflect ===");
  console.log(`Workspace: ${workspaceDir}`);
  console.log(`Options: force=${force}, skipSynthesis=${skipSynthesis}`);
  console.log("");

  try {
    const result = await runReflect({
      workspaceDir,
      force,
      skipSynthesis,
    });

    if (result.skipped) {
      console.log(`⏭️  ${result.skipReason}`);
    }

    // Print status summary
    const store = BankIndexStore.open(workspaceDir);
    try {
      const status = store.status();
      console.log("");
      console.log("--- Bank Status ---");
      console.log(`Facts: ${status.facts}`);
      console.log(`Entity pages: ${status.entityPages}`);
      console.log(`Opinions: ${status.opinions}`);
      console.log(
        `Last ingest: ${status.lastIngest ? new Date(status.lastIngest).toISOString() : "never"}`,
      );
      console.log(
        `Last reflect: ${status.lastReflect ? new Date(status.lastReflect).toISOString() : "never"}`,
      );
    } finally {
      store.close();
    }
  } catch (err) {
    console.error("❌ Reflect failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
