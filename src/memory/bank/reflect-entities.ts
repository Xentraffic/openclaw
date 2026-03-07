/**
 * Reflect module — Entity Page Generator.
 *
 * Generates/updates curated Markdown pages for each entity mentioned in the
 * Bank index.  Pages live at `<workspace>/memory/entities/<slug>.md` and
 * summarize everything the agent knows about a person, project, or concept.
 *
 * Only regenerates a page if the fact set changed since the last reflect.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { BankIndexStore } from "./index-store.js";
import type { FactEntry, FactKind } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ReflectEntitiesResult = {
  /** Total entities examined. */
  entitiesProcessed: number;
  /** Entity pages created or updated. */
  pagesUpdated: number;
  /** Duration in ms. */
  durationMs: number;
};

/**
 * Generate or update entity pages in `workspace/memory/entities/`.
 *
 * For each entity:
 * 1. Query all facts mentioning the entity.
 * 2. Compare fact count + IDs with the stored page hash.
 * 3. If changed, regenerate the Markdown page.
 */
export async function reflectEntities(
  workspaceDir: string,
  store: BankIndexStore,
): Promise<ReflectEntitiesResult> {
  const start = Date.now();
  const entitiesDir = path.join(workspaceDir, "memory", "entities");
  await fs.mkdir(entitiesDir, { recursive: true });

  // Get all unique entities
  const entities = listEntities(store);
  let pagesUpdated = 0;

  for (const entity of entities) {
    const facts = getEntityFacts(store, entity);
    if (facts.length === 0) {
      continue;
    }

    // Build a fingerprint to detect changes
    const fingerprint = buildFingerprint(facts);
    const metaKey = `entity_hash:${entity}`;
    const storedFingerprint = store.getMeta(metaKey);

    if (storedFingerprint === fingerprint) {
      continue; // No changes
    }

    // Generate the entity page
    const markdown = generateEntityPage(entity, facts);
    const pagePath = path.join(entitiesDir, `${slugify(entity)}.md`);
    await fs.writeFile(pagePath, markdown, "utf-8");

    // Store the fingerprint
    store.setMeta(metaKey, fingerprint);
    pagesUpdated++;
  }

  return {
    entitiesProcessed: entities.length,
    pagesUpdated,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function listEntities(store: BankIndexStore): string[] {
  const rows = store.db
    .prepare("SELECT DISTINCT entity FROM entity_facts ORDER BY entity")
    .all() as Array<{ entity: string }>;
  return rows.map((r) => r.entity);
}

function getEntityFacts(store: BankIndexStore, entity: string): FactEntry[] {
  const rows = store.db
    .prepare(
      `SELECT f.* FROM facts f
       JOIN entity_facts ef ON ef.fact_id = f.id
       WHERE ef.entity = ?
       ORDER BY f.source_date ASC, f.indexed_at ASC`,
    )
    .all(entity) as Array<{
    id: string;
    kind: string;
    content: string;
    source_file: string;
    source_line: number;
    source_date: string | null;
    confidence: number | null;
    indexed_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as FactKind,
    content: row.content,
    entities: getFactEntities(store, row.id),
    sourceFile: row.source_file,
    sourceLine: row.source_line,
    sourceDate: row.source_date,
    confidence: row.confidence ?? undefined,
    indexedAt: row.indexed_at,
  }));
}

function getFactEntities(store: BankIndexStore, factId: string): string[] {
  const rows = store.db
    .prepare("SELECT entity FROM entity_facts WHERE fact_id = ?")
    .all(factId) as Array<{ entity: string }>;
  return rows.map((r) => r.entity);
}

function buildFingerprint(facts: FactEntry[]): string {
  // Sort IDs for determinism, join with count
  const ids = facts.map((f) => f.id).toSorted();
  return `${ids.length}:${ids.join(",")}`;
}

function generateEntityPage(entity: string, facts: FactEntry[]): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${entity}`);
  lines.push("");

  // Stats
  const dates = facts
    .map((f) => f.sourceDate)
    .filter((d): d is string => d != null)
    .toSorted();
  const firstSeen = dates[0] ?? "unknown";
  const lastSeen = dates[dates.length - 1] ?? "unknown";
  lines.push(
    `> **Facts**: ${facts.length} | **First seen**: ${firstSeen} | **Last seen**: ${lastSeen}`,
  );
  lines.push("");

  // Group by kind
  const grouped = groupByKind(facts);

  // World facts (objective info)
  if (grouped.world.length > 0) {
    lines.push("## World Facts");
    lines.push("");
    for (const fact of grouped.world) {
      lines.push(`- ${fact.content}${dateTag(fact.sourceDate)}`);
    }
    lines.push("");
  }

  // Experience (what happened)
  if (grouped.experience.length > 0) {
    lines.push("## Experiences");
    lines.push("");
    for (const fact of grouped.experience) {
      lines.push(`- ${fact.content}${dateTag(fact.sourceDate)}`);
    }
    lines.push("");
  }

  // Opinions (with confidence)
  if (grouped.opinion.length > 0) {
    lines.push("## Opinions");
    lines.push("");
    for (const fact of grouped.opinion) {
      const conf = fact.confidence != null ? ` *(c=${(fact.confidence * 100).toFixed(0)}%)*` : "";
      lines.push(`- ${fact.content}${conf}${dateTag(fact.sourceDate)}`);
    }
    lines.push("");
  }

  // Summaries
  if (grouped.summary.length > 0) {
    lines.push("## Observations");
    lines.push("");
    for (const fact of grouped.summary) {
      lines.push(`- ${fact.content}${dateTag(fact.sourceDate)}`);
    }
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push(`*Auto-generated by OpenClaw Reflect on ${new Date().toISOString().slice(0, 10)}*`);
  lines.push("");

  return lines.join("\n");
}

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

function dateTag(date: string | null): string {
  return date ? ` [${date}]` : "";
}

function slugify(entity: string): string {
  return entity
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
