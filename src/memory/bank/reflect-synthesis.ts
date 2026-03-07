/**
 * Reflect module — Weekly Synthesis.
 *
 * Gathers facts from the past 7 days, groups them by entity and kind,
 * and generates a structured weekly summary document at:
 *   `<workspace>/memory/weekly/YYYY-WXX.md`
 *
 * The synthesis is template-based (no LLM call) and captures:
 *   - New facts learned this week
 *   - Entities most discussed
 *   - Opinion confidence changes
 *   - Open questions / low-confidence opinions
 *
 * The summary facts (kind=S) are also ingested back into the Bank index.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BankIndexStore } from "./index-store.js";
import type { FactEntry, FactKind, OpinionEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ReflectSynthesisResult = {
  /** ISO week identifier (e.g. "2026-W10"). */
  weekId: string;
  /** Number of facts included in the synthesis. */
  factsAnalyzed: number;
  /** Number of summary facts written back to the index. */
  summaryFactsCreated: number;
  /** Path to the generated weekly file. */
  filePath: string;
  /** Whether a new file was written (false if already up-to-date). */
  written: boolean;
  /** Duration in ms. */
  durationMs: number;
};

/**
 * Generate the weekly synthesis report.
 *
 * @param workspaceDir  Agent workspace directory
 * @param store         Open BankIndexStore
 * @param options       Optional: force regeneration, custom date
 */
export async function reflectSynthesis(
  workspaceDir: string,
  store: BankIndexStore,
  options?: { force?: boolean; referenceDate?: Date },
): Promise<ReflectSynthesisResult> {
  const start = Date.now();
  const refDate = options?.referenceDate ?? new Date();

  // Calculate ISO week boundaries
  const { weekId, weekStart, weekEnd } = getISOWeekBounds(refDate);

  // Check if already generated
  const weeklyDir = path.join(workspaceDir, "memory", "weekly");
  await fs.mkdir(weeklyDir, { recursive: true });
  const filePath = path.join(weeklyDir, `${weekId}.md`);
  const metaKey = `synthesis:${weekId}`;

  if (!options?.force && store.getMeta(metaKey)) {
    return {
      weekId,
      factsAnalyzed: 0,
      summaryFactsCreated: 0,
      filePath,
      written: false,
      durationMs: Date.now() - start,
    };
  }

  // Gather facts from the week
  const sinceStr = formatDate(weekStart);
  const untilStr = formatDate(weekEnd);
  const weekFacts = queryFactsInRange(store, sinceStr, untilStr);

  // Gather opinions for low-confidence report
  const opinions = store.listOpinions();
  const lowConfidence = opinions.filter((o) => o.confidence < 0.4);

  // Generate the markdown
  const markdown = generateWeeklySynthesis(
    weekId,
    sinceStr,
    untilStr,
    weekFacts,
    opinions,
    lowConfidence,
  );
  await fs.writeFile(filePath, markdown, "utf-8");

  // Write summary facts back to the index
  const summaryFacts = generateSummaryFacts(weekId, weekFacts, filePath, workspaceDir);
  if (summaryFacts.length > 0) {
    store.upsertFacts(summaryFacts);
  }

  // Mark as done
  store.setMeta(metaKey, String(Date.now()));

  return {
    weekId,
    factsAnalyzed: weekFacts.length,
    summaryFactsCreated: summaryFacts.length,
    filePath,
    written: true,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function queryFactsInRange(store: BankIndexStore, since: string, until: string): FactEntry[] {
  const rows = store.db
    .prepare(
      `SELECT f.* FROM facts f
       WHERE f.source_date >= ? AND f.source_date <= ?
       ORDER BY f.source_date ASC, f.indexed_at ASC`,
    )
    .all(since, until) as Array<{
    id: string;
    kind: string;
    content: string;
    source_file: string;
    source_line: number;
    source_date: string | null;
    confidence: number | null;
    indexed_at: number;
  }>;

  return rows.map((row) => {
    const entities = store.db
      .prepare("SELECT entity FROM entity_facts WHERE fact_id = ?")
      .all(row.id) as Array<{ entity: string }>;

    return {
      id: row.id,
      kind: row.kind as FactKind,
      content: row.content,
      entities: entities.map((e) => e.entity),
      sourceFile: row.source_file,
      sourceLine: row.source_line,
      sourceDate: row.source_date,
      confidence: row.confidence ?? undefined,
      indexedAt: row.indexed_at,
    };
  });
}

function generateWeeklySynthesis(
  weekId: string,
  since: string,
  until: string,
  facts: FactEntry[],
  allOpinions: OpinionEntry[],
  lowConfidence: OpinionEntry[],
): string {
  const lines: string[] = [];

  lines.push(`# Weekly Synthesis: ${weekId}`);
  lines.push("");
  lines.push(`> Period: ${since} to ${until}`);
  lines.push(`> Facts recorded: ${facts.length}`);
  lines.push("");

  if (facts.length === 0) {
    lines.push("*No facts were recorded this week.*");
    lines.push("");
    return lines.join("\n");
  }

  // --- Breakdown by kind ---
  const byKind = groupByKind(facts);
  lines.push("## Breakdown");
  lines.push("");
  lines.push(`| Kind | Count |`);
  lines.push(`|------|-------|`);
  for (const kind of ["world", "experience", "opinion", "summary"] as FactKind[]) {
    const count = byKind[kind]?.length ?? 0;
    if (count > 0) {
      lines.push(`| ${kindLabel(kind)} | ${count} |`);
    }
  }
  lines.push("");

  // --- Top entities ---
  const entityCounts = countEntities(facts);
  if (entityCounts.length > 0) {
    lines.push("## Top Entities");
    lines.push("");
    for (const { entity, count } of entityCounts.slice(0, 10)) {
      lines.push(`- **${entity}**: ${count} fact${count !== 1 ? "s" : ""}`);
    }
    lines.push("");
  }

  // --- New world facts ---
  if (byKind.world.length > 0) {
    lines.push("## New World Facts");
    lines.push("");
    for (const fact of byKind.world.slice(0, 20)) {
      const entities = fact.entities.length > 0 ? ` @${fact.entities.join(" @")}` : "";
      lines.push(`- ${fact.content}${entities} [${fact.sourceDate ?? "?"}]`);
    }
    if (byKind.world.length > 20) {
      lines.push(`- *...and ${byKind.world.length - 20} more*`);
    }
    lines.push("");
  }

  // --- Key experiences ---
  if (byKind.experience.length > 0) {
    lines.push("## Key Experiences");
    lines.push("");
    for (const fact of byKind.experience.slice(0, 15)) {
      lines.push(`- ${fact.content} [${fact.sourceDate ?? "?"}]`);
    }
    if (byKind.experience.length > 15) {
      lines.push(`- *...and ${byKind.experience.length - 15} more*`);
    }
    lines.push("");
  }

  // --- Opinion changes ---
  if (byKind.opinion.length > 0) {
    lines.push("## Opinions Formed/Updated");
    lines.push("");
    for (const fact of byKind.opinion) {
      const conf = fact.confidence != null ? ` (c=${(fact.confidence * 100).toFixed(0)}%)` : "";
      lines.push(`- ${fact.content}${conf}`);
    }
    lines.push("");
  }

  // --- Low confidence opinions ---
  if (lowConfidence.length > 0) {
    lines.push("## Low Confidence Opinions (Needs Review)");
    lines.push("");
    for (const op of lowConfidence.slice(0, 10)) {
      lines.push(`- ${op.statement} *(c=${(op.confidence * 100).toFixed(0)}%)*`);
    }
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push(`*Auto-generated by OpenClaw Reflect on ${new Date().toISOString().slice(0, 10)}*`);
  lines.push("");

  return lines.join("\n");
}

function generateSummaryFacts(
  weekId: string,
  facts: FactEntry[],
  filePath: string,
  workspaceDir: string,
): FactEntry[] {
  if (facts.length === 0) {
    return [];
  }

  const relPath = path.relative(workspaceDir, filePath).replace(/\\/g, "/");
  const now = Date.now();

  // Create one summary fact per top entity
  const entityCounts = countEntities(facts);
  const summaryFacts: FactEntry[] = [];

  // Overall week summary
  const byKind = groupByKind(facts);
  const parts: string[] = [];
  if (byKind.world.length > 0) {
    parts.push(`${byKind.world.length} world facts`);
  }
  if (byKind.experience.length > 0) {
    parts.push(`${byKind.experience.length} experiences`);
  }
  if (byKind.opinion.length > 0) {
    parts.push(`${byKind.opinion.length} opinions`);
  }

  summaryFacts.push({
    id: synthId(weekId, "overview"),
    kind: "summary",
    content: `Week ${weekId}: Recorded ${facts.length} facts (${parts.join(", ")}). Top entities: ${entityCounts
      .slice(0, 5)
      .map((e) => e.entity)
      .join(", ")}.`,
    entities: entityCounts.slice(0, 5).map((e) => e.entity),
    sourceFile: relPath,
    sourceLine: 1,
    sourceDate: weekId, // Use weekId as date marker
    indexedAt: now,
  });

  return summaryFacts;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function groupByKind(facts: FactEntry[]): Record<FactKind, FactEntry[]> {
  const grouped: Record<FactKind, FactEntry[]> = {
    world: [],
    experience: [],
    opinion: [],
    summary: [],
  };
  for (const fact of facts) {
    grouped[fact.kind].push(fact);
  }
  return grouped;
}

function countEntities(facts: FactEntry[]): Array<{ entity: string; count: number }> {
  const counts = new Map<string, number>();
  for (const fact of facts) {
    for (const entity of fact.entities) {
      counts.set(entity, (counts.get(entity) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([entity, count]) => ({ entity, count }))
    .toSorted((a, b) => b.count - a.count);
}

function kindLabel(kind: FactKind): string {
  switch (kind) {
    case "world":
      return "World";
    case "experience":
      return "Experience";
    case "opinion":
      return "Opinion";
    case "summary":
      return "Summary";
  }
}

function getISOWeekBounds(date: Date): { weekId: string; weekStart: Date; weekEnd: Date } {
  // Calculate ISO week number
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Make Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Set to nearest Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

  const year = d.getUTCFullYear();
  const weekId = `${year}-W${String(weekNo).padStart(2, "0")}`;

  // Week start (Monday) and end (Sunday)
  const refDay = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayOfWeek = refDay.getUTCDay() || 7; // Mon=1, Sun=7
  const weekStart = new Date(refDay);
  weekStart.setUTCDate(refDay.getUTCDate() - dayOfWeek + 1);

  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);

  return { weekId, weekStart, weekEnd };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function synthId(weekId: string, label: string): string {
  return crypto
    .createHash("sha256")
    .update(`synthesis:${weekId}:${label}`)
    .digest("hex")
    .slice(0, 16);
}
