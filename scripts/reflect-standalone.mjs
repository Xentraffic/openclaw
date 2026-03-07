#!/usr/bin/env node
/**
 * Standalone reflect runner for cron jobs.
 *
 * Usage:
 *   node --experimental-sqlite scripts/reflect-standalone.mjs [--force] [--skip-synthesis]
 *
 * Environment:
 *   OPENCLAW_WORKSPACE — workspace dir (default: ~/.openclaw/workspace)
 *
 * This script is self-contained and does not depend on the bundled dist.
 * It directly uses node:sqlite to read/write the Bank index.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WORKSPACE =
  process.env.OPENCLAW_WORKSPACE ||
  path.join(process.env.HOME || "/home/xenhive", ".openclaw", "workspace");
const DEBOUNCE_MS = 6 * 60 * 60 * 1000; // 6 hours
const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const SKIP_SYNTHESIS = args.has("--skip-synthesis");

console.log("=== OpenClaw Reflect (standalone) ===");
console.log(`Workspace: ${WORKSPACE}`);
console.log(`Options: force=${FORCE}, skipSynthesis=${SKIP_SYNTHESIS}`);
console.log("");

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const indexDir = path.join(WORKSPACE, ".memory");
fs.mkdirSync(indexDir, { recursive: true });
const dbPath = path.join(indexDir, "index.sqlite");

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// Ensure schema exists
db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
  source_file TEXT NOT NULL, source_line INTEGER NOT NULL, source_date TEXT,
  confidence REAL, indexed_at INTEGER NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS entity_facts (
  entity TEXT NOT NULL, fact_id TEXT NOT NULL,
  PRIMARY KEY (entity, fact_id), FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
)`);
db.exec(`CREATE TABLE IF NOT EXISTS opinions (
  id TEXT PRIMARY KEY, statement TEXT NOT NULL, confidence REAL NOT NULL,
  entities TEXT NOT NULL DEFAULT '[]', last_updated TEXT NOT NULL,
  supporting_facts TEXT NOT NULL DEFAULT '[]', contradicting_facts TEXT NOT NULL DEFAULT '[]'
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_facts_entity ON entity_facts(entity)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_source_file ON facts(source_file)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_kind ON facts(kind)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_source_date ON facts(source_date)`);
try {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    content, id UNINDEXED, kind UNINDEXED, source_file UNINDEXED, source_date UNINDEXED
  )`);
} catch {
  /* FTS5 not available */
}

// ---------------------------------------------------------------------------
// Step 0: Ingest daily logs (lightweight — only re-indexes changed files)
// ---------------------------------------------------------------------------

console.log("🔄 Ingesting daily logs...");

const KIND_PREFIX_RE = /^([WBOS])(?:\(c=(\d+(?:\.\d+)?)\))?\s+/;
const ENTITY_RE = /@([A-Za-z0-9_-]+)/g;
const LEADING_ENTITIES_RE = /^(?:@[A-Za-z0-9_-]+\s*)+:\s*/;

function parseRetainSections(content) {
  const lines = content.split("\n");
  const results = [];
  let insideRetain = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] || "";
    const lineNo = i + 1;
    if (/^#{1,3}\s/.test(raw)) {
      insideRetain = /^#{1,3}\s+retain\b/i.test(raw.trim());
      continue;
    }
    if (!insideRetain) {
      continue;
    }
    const bulletMatch = raw.match(/^\s*[-*]\s+(.*)/);
    if (!bulletMatch) {
      continue;
    }
    const text = (bulletMatch[1] || "").trim();
    if (!text) {
      continue;
    }
    const kindMatch = text.match(KIND_PREFIX_RE);
    let kind = "summary",
      confidence,
      remainder = text;
    if (kindMatch) {
      kind = { W: "world", B: "experience", O: "opinion", S: "summary" }[kindMatch[1]] || "summary";
      if (kindMatch[1] === "O" && kindMatch[2]) {
        const p = parseFloat(kindMatch[2]);
        if (!isNaN(p) && p >= 0 && p <= 1) {
          confidence = p;
        }
      }
      remainder = text.slice(kindMatch[0].length);
    }
    ENTITY_RE.lastIndex = 0;
    const entities = [];
    let m;
    while ((m = ENTITY_RE.exec(remainder)) !== null) {
      if (m[1] && !entities.includes(m[1])) {
        entities.push(m[1]);
      }
    }
    const cleanContent = remainder.replace(LEADING_ENTITIES_RE, "").trim() || remainder.trim();
    if (!cleanContent) {
      continue;
    }
    results.push({ kind, content: cleanContent, entities, confidence, lineNo });
  }
  return results;
}

const memoryDir = path.join(WORKSPACE, "memory");
let filesIngested = 0,
  factsIngested = 0;
if (fs.existsSync(memoryDir)) {
  const logFiles = fs
    .readdirSync(memoryDir)
    .filter((f) => f.endsWith(".md") && /\d{4}-\d{2}-\d{2}/.test(f));
  for (const filename of logFiles) {
    const absPath = path.join(memoryDir, filename);
    const content = fs.readFileSync(absPath, "utf-8");
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const relPath = `memory/${filename}`;
    const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
    const sourceDate = dateMatch ? dateMatch[1] : null;
    const storedHash = getMeta(`file_hash:${relPath}`);
    if (!FORCE && storedHash === hash) {
      continue;
    }
    // Remove old facts from this file
    const oldIds = db.prepare("SELECT id FROM facts WHERE source_file = ?").all(relPath);
    if (oldIds.length > 0) {
      db.exec("BEGIN");
      for (const { id } of oldIds) {
        db.prepare("DELETE FROM entity_facts WHERE fact_id = ?").run(id);
        try {
          db.prepare("DELETE FROM facts_fts WHERE id = ?").run(id);
        } catch {}
      }
      db.prepare("DELETE FROM facts WHERE source_file = ?").run(relPath);
      db.exec("COMMIT");
    }
    const retainLines = parseRetainSections(content);
    if (retainLines.length > 0) {
      db.exec("BEGIN");
      for (const line of retainLines) {
        const id = crypto
          .createHash("sha256")
          .update(`${relPath}:${line.lineNo}`)
          .digest("hex")
          .slice(0, 16);
        db.prepare(`INSERT INTO facts (id,kind,content,source_file,source_line,source_date,confidence,indexed_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,content=excluded.content,
          source_file=excluded.source_file,source_line=excluded.source_line,source_date=excluded.source_date,
          confidence=excluded.confidence,indexed_at=excluded.indexed_at`).run(
          id,
          line.kind,
          line.content,
          relPath,
          line.lineNo,
          sourceDate,
          line.confidence ?? null,
          Date.now(),
        );
        db.prepare("DELETE FROM entity_facts WHERE fact_id = ?").run(id);
        for (const entity of line.entities) {
          db.prepare("INSERT OR IGNORE INTO entity_facts (entity, fact_id) VALUES (?, ?)").run(
            entity,
            id,
          );
        }
        try {
          db.prepare("DELETE FROM facts_fts WHERE id = ?").run(id);
          db.prepare(
            "INSERT INTO facts_fts (content,id,kind,source_file,source_date) VALUES (?,?,?,?,?)",
          ).run(line.content, id, line.kind, relPath, sourceDate);
        } catch {}
        if (line.kind === "opinion") {
          db.prepare(`INSERT INTO opinions (id,statement,confidence,entities,last_updated,supporting_facts,contradicting_facts)
            VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET statement=excluded.statement,confidence=excluded.confidence,
            entities=excluded.entities,last_updated=excluded.last_updated`).run(
            id,
            line.content,
            line.confidence ?? 0.5,
            JSON.stringify(line.entities),
            sourceDate || new Date().toISOString().slice(0, 10),
            JSON.stringify([id]),
            "[]",
          );
        }
        factsIngested++;
      }
      db.exec("COMMIT");
    }
    setMeta(`file_hash:${relPath}`, hash);
    filesIngested++;
  }
}
setMeta("last_ingest", String(Date.now()));
console.log(`   ↳ ${filesIngested} files ingested, ${factsIngested} facts upserted`);

function getMeta(key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row?.value ?? null;
}

function setMeta(key, value) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
  ).run(key, value, value);
}

// ---------------------------------------------------------------------------
// Debounce check
// ---------------------------------------------------------------------------

if (!FORCE) {
  const lastReflect = getMeta("last_reflect");
  if (lastReflect) {
    const elapsed = Date.now() - parseInt(lastReflect, 10);
    if (elapsed < DEBOUNCE_MS) {
      const hoursAgo = (elapsed / 3600000).toFixed(1);
      console.log(`⏭️  Last reflect was ${hoursAgo}h ago (debounce: 6h). Use --force to override.`);
      db.close();
      process.exit(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 1: Opinion confidence updates
// ---------------------------------------------------------------------------

console.log("💭 Updating opinion confidence scores...");

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "can",
  "could",
  "may",
  "might",
  "must",
  "ought",
  "i",
  "me",
  "my",
  "mine",
  "we",
  "our",
  "ours",
  "you",
  "your",
  "yours",
  "he",
  "him",
  "his",
  "she",
  "her",
  "hers",
  "it",
  "its",
  "they",
  "them",
  "their",
  "theirs",
  "that",
  "this",
  "these",
  "those",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "no",
  "so",
  "if",
  "then",
  "very",
  "really",
  "also",
  "just",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "only",
  "each",
  "every",
  "all",
  "both",
  "few",
  "many",
  "much",
  "own",
  "same",
  "prefers",
  "likes",
  "wants",
]);

function extractSearchTerms(statement) {
  const words = statement
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return words
    .slice(0, 6)
    .map((w) => `"${w.replace(/"/g, "")}"`)
    .join(" ");
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

let opinionsUpdated = 0;
const opinions = db.prepare("SELECT * FROM opinions ORDER BY confidence DESC").all();

let ftsAvailable = true;
try {
  db.prepare("SELECT * FROM facts_fts LIMIT 1").get();
} catch {
  ftsAvailable = false;
  console.log("   ⚠️ FTS5 not available — skipping opinion evidence search");
}

if (ftsAvailable) {
  for (const op of opinions) {
    const searchTerms = extractSearchTerms(op.statement);
    if (!searchTerms) {
      continue;
    }

    const opEntities = safeJsonParse(op.entities, []);

    // FTS search for related facts
    let relatedFacts;
    try {
      relatedFacts = db
        .prepare(
          `SELECT f.*, fts.rank AS fts_rank
         FROM facts_fts fts
         JOIN facts f ON f.id = fts.id
         WHERE facts_fts MATCH ?
         LIMIT 50`,
        )
        .all(searchTerms);
    } catch {
      continue;
    }

    const supporting = [op.id];
    const contradicting = [];

    for (const fact of relatedFacts) {
      if (fact.id === op.id) {
        continue;
      }

      // Get entities for this fact
      const factEntities = db
        .prepare("SELECT entity FROM entity_facts WHERE fact_id = ?")
        .all(fact.id)
        .map((r) => r.entity);

      // Require entity overlap
      if (opEntities.length > 0) {
        const hasOverlap = factEntities.some((e) => opEntities.includes(e));
        if (!hasOverlap) {
          continue;
        }
      }

      if (fact.kind === "world" || fact.kind === "experience" || fact.kind === "summary") {
        supporting.push(fact.id);
      } else if (fact.kind === "opinion" && fact.id !== op.id) {
        const otherConf = fact.confidence ?? 0.5;
        if (Math.abs(otherConf - op.confidence) > 0.4) {
          contradicting.push(fact.id);
        }
      }
    }

    // Get base confidence from originating fact
    const origFact = db.prepare("SELECT confidence FROM facts WHERE id = ?").get(op.id);
    const baseConf = origFact?.confidence ?? 0.5;

    // Calculate new confidence
    const supports = supporting.length - 1;
    const contradictions = contradicting.length;
    let newConf = baseConf * (1 + 0.1 * supports - 0.15 * contradictions);
    newConf = Math.max(0.05, Math.min(0.99, newConf));

    // Check if changed
    const oldSupporting = safeJsonParse(op.supporting_facts, []);
    const oldContradicting = safeJsonParse(op.contradicting_facts, []);
    const confChanged = Math.abs(newConf - op.confidence) > 0.001;
    const suppChanged =
      JSON.stringify(supporting.toSorted((a, b) => String(a).localeCompare(String(b)))) !==
      JSON.stringify(oldSupporting.toSorted((a, b) => String(a).localeCompare(String(b))));
    const contrChanged =
      JSON.stringify(contradicting.toSorted((a, b) => String(a).localeCompare(String(b)))) !==
      JSON.stringify(oldContradicting.toSorted((a, b) => String(a).localeCompare(String(b))));

    if (!confChanged && !suppChanged && !contrChanged) {
      continue;
    }

    db.prepare(
      `UPDATE opinions SET confidence = ?, supporting_facts = ?, contradicting_facts = ?, last_updated = ?
       WHERE id = ?`,
    ).run(
      newConf,
      JSON.stringify(supporting),
      JSON.stringify(contradicting),
      new Date().toISOString().slice(0, 10),
      op.id,
    );

    opinionsUpdated++;
  }
}

console.log(`   ↳ ${opinions.length} opinions processed, ${opinionsUpdated} updated`);

// ---------------------------------------------------------------------------
// Step 2: Entity page generation
// ---------------------------------------------------------------------------

console.log("📄 Generating entity pages...");

const entitiesDir = path.join(WORKSPACE, "memory", "entities");
fs.mkdirSync(entitiesDir, { recursive: true });

const entities = db.prepare("SELECT DISTINCT entity FROM entity_facts ORDER BY entity").all();
let pagesUpdated = 0;

for (const { entity } of entities) {
  const facts = db
    .prepare(
      `SELECT f.* FROM facts f
     JOIN entity_facts ef ON ef.fact_id = f.id
     WHERE ef.entity = ?
     ORDER BY f.source_date ASC, f.indexed_at ASC`,
    )
    .all(entity);

  if (facts.length === 0) {
    continue;
  }

  // Build fingerprint
  const ids = facts.map((f) => f.id).toSorted((a, b) => String(a).localeCompare(String(b)));
  const fingerprint = `${ids.length}:${ids.join(",")}`;
  const metaKey = `entity_hash:${String(entity)}`;
  const stored = getMeta(metaKey);

  if (stored === fingerprint) {
    continue;
  }

  // Group facts by kind
  const grouped = { world: [], experience: [], opinion: [], summary: [] };
  for (const f of facts) {
    (grouped[f.kind] || grouped.summary).push(f);
  }

  const dates = facts
    .map((f) => f.source_date)
    .filter(Boolean)
    .toSorted((a, b) => String(a).localeCompare(String(b)));
  const firstSeen = dates[0] || "unknown";
  const lastSeen = dates[dates.length - 1] || "unknown";

  let md = `# ${String(entity)}\n\n`;
  md += `> **Facts**: ${facts.length} | **First seen**: ${firstSeen} | **Last seen**: ${lastSeen}\n\n`;

  if (grouped.world.length > 0) {
    md += `## World Facts\n\n`;
    for (const f of grouped.world) {
      md += `- ${f.content}${f.source_date ? ` [${f.source_date}]` : ""}\n`;
    }
    md += "\n";
  }
  if (grouped.experience.length > 0) {
    md += `## Experiences\n\n`;
    for (const f of grouped.experience) {
      md += `- ${f.content}${f.source_date ? ` [${f.source_date}]` : ""}\n`;
    }
    md += "\n";
  }
  if (grouped.opinion.length > 0) {
    md += `## Opinions\n\n`;
    for (const f of grouped.opinion) {
      const conf = f.confidence != null ? ` *(c=${(f.confidence * 100).toFixed(0)}%)*` : "";
      md += `- ${f.content}${conf}${f.source_date ? ` [${f.source_date}]` : ""}\n`;
    }
    md += "\n";
  }
  if (grouped.summary.length > 0) {
    md += `## Observations\n\n`;
    for (const f of grouped.summary) {
      md += `- ${f.content}${f.source_date ? ` [${f.source_date}]` : ""}\n`;
    }
    md += "\n";
  }

  md += `---\n*Auto-generated by OpenClaw Reflect on ${new Date().toISOString().slice(0, 10)}*\n`;

  const slug = entity
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  fs.writeFileSync(path.join(entitiesDir, `${slug}.md`), md);
  setMeta(metaKey, fingerprint);
  pagesUpdated++;
}

console.log(`   ↳ ${entities.length} entities processed, ${pagesUpdated} pages updated`);

// ---------------------------------------------------------------------------
// Step 3: Weekly synthesis (Sunday or --force)
// ---------------------------------------------------------------------------

const isSunday = new Date().getUTCDay() === 0;

if (!SKIP_SYNTHESIS && (isSunday || FORCE)) {
  console.log("📊 Generating weekly synthesis...");

  // Calculate ISO week
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const weekId = `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;

  // Week boundaries
  const refDay = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dow = refDay.getUTCDay() || 7;
  const weekStart = new Date(refDay);
  weekStart.setUTCDate(refDay.getUTCDate() - dow + 1);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);

  const sinceStr = weekStart.toISOString().slice(0, 10);
  const untilStr = weekEnd.toISOString().slice(0, 10);

  const synthKey = `synthesis:${weekId}`;
  if (!FORCE && getMeta(synthKey)) {
    console.log(`   ↳ ${weekId}: already generated`);
  } else {
    const weekFacts = db
      .prepare(
        "SELECT * FROM facts WHERE source_date >= ? AND source_date <= ? ORDER BY source_date ASC",
      )
      .all(sinceStr, untilStr);

    const weeklyDir = path.join(WORKSPACE, "memory", "weekly");
    fs.mkdirSync(weeklyDir, { recursive: true });

    // Group by kind
    const byKind = { world: [], experience: [], opinion: [], summary: [] };
    for (const f of weekFacts) {
      (byKind[f.kind] || byKind.summary).push(f);
    }

    // Count entities
    const entityCounts = {};
    for (const f of weekFacts) {
      const ents = db.prepare("SELECT entity FROM entity_facts WHERE fact_id = ?").all(f.id);
      for (const { entity: e } of ents) {
        entityCounts[e] = (entityCounts[e] || 0) + 1;
      }
    }
    const topEntities = Object.entries(entityCounts)
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 10);

    let md = `# Weekly Synthesis: ${weekId}\n\n`;
    md += `> Period: ${sinceStr} to ${untilStr}\n`;
    md += `> Facts recorded: ${weekFacts.length}\n\n`;

    if (weekFacts.length > 0) {
      md += `## Breakdown\n\n| Kind | Count |\n|------|-------|\n`;
      for (const [kind, label] of [
        ["world", "World"],
        ["experience", "Experience"],
        ["opinion", "Opinion"],
        ["summary", "Summary"],
      ]) {
        if (byKind[kind].length > 0) {
          md += `| ${label} | ${byKind[kind].length} |\n`;
        }
      }
      md += "\n";

      if (topEntities.length > 0) {
        md += `## Top Entities\n\n`;
        for (const [e, c] of topEntities) {
          md += `- **${e}**: ${c} fact${c !== 1 ? "s" : ""}\n`;
        }
        md += "\n";
      }

      if (byKind.world.length > 0) {
        md += `## New World Facts\n\n`;
        for (const f of byKind.world.slice(0, 20)) {
          md += `- ${f.content} [${f.source_date || "?"}]\n`;
        }
        md += "\n";
      }
    } else {
      md += "*No facts were recorded this week.*\n\n";
    }

    md += `---\n*Auto-generated by OpenClaw Reflect on ${new Date().toISOString().slice(0, 10)}*\n`;

    fs.writeFileSync(path.join(weeklyDir, `${weekId}.md`), md);

    // Write overview summary fact
    if (weekFacts.length > 0) {
      const synthFactId = crypto
        .createHash("sha256")
        .update(`synthesis:${weekId}:overview`)
        .digest("hex")
        .slice(0, 16);
      const parts = [];
      if (byKind.world.length) {
        parts.push(`${byKind.world.length} world facts`);
      }
      if (byKind.experience.length) {
        parts.push(`${byKind.experience.length} experiences`);
      }
      if (byKind.opinion.length) {
        parts.push(`${byKind.opinion.length} opinions`);
      }
      const content = `Week ${weekId}: Recorded ${weekFacts.length} facts (${parts.join(", ")}). Top entities: ${topEntities
        .slice(0, 5)
        .map((e) => e[0])
        .join(", ")}.`;

      db.prepare(
        `INSERT INTO facts (id, kind, content, source_file, source_line, source_date, confidence, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, indexed_at = excluded.indexed_at`,
      ).run(
        synthFactId,
        "summary",
        content,
        `memory/weekly/${weekId}.md`,
        1,
        weekId,
        null,
        Date.now(),
      );
    }

    setMeta(synthKey, String(Date.now()));
    console.log(`   ↳ ${weekId}: ${weekFacts.length} facts analyzed`);
  }
} else if (!SKIP_SYNTHESIS) {
  console.log("📊 Weekly synthesis: skipped (runs on Sundays)");
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

setMeta("last_reflect", String(Date.now()));

// Print status
const factCount = db.prepare("SELECT COUNT(*) AS cnt FROM facts").get().cnt;
const opinionCount = db.prepare("SELECT COUNT(*) AS cnt FROM opinions").get().cnt;
const entityCount = db.prepare("SELECT COUNT(DISTINCT entity) AS cnt FROM entity_facts").get().cnt;
const lastIngest = getMeta("last_ingest");
const lastReflect = getMeta("last_reflect");

console.log("");
console.log("--- Bank Status ---");
console.log(`Facts: ${String(factCount)}`);
console.log(`Entities: ${String(entityCount)}`);
console.log(`Opinions: ${String(opinionCount)}`);
console.log(`Last ingest: ${lastIngest ? new Date(parseInt(lastIngest)).toISOString() : "never"}`);
console.log(
  `Last reflect: ${lastReflect ? new Date(parseInt(lastReflect)).toISOString() : "never"}`,
);
console.log("");
console.log("✅ Reflect complete");

db.close();
