/**
 * Reflect module — Opinion confidence updates.
 *
 * Analyzes the Bank index to find evidence supporting or contradicting
 * existing opinions, then adjusts confidence scores accordingly.
 *
 * Confidence formula (idempotent):
 *   new = clamp(baseConfidence * (1 + 0.1 * supports - 0.15 * contradictions), 0.05, 0.99)
 *
 * Base confidence is always read from the originating fact (the O-prefixed
 * line in a daily log), so running reflect repeatedly with the same evidence
 * produces the same result.
 */

import type { BankIndexStore } from "./index-store.js";
import type { OpinionEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ReflectOpinionResult = {
  /** Total opinions examined. */
  opinionsProcessed: number;
  /** Opinions whose confidence or evidence links changed. */
  opinionsUpdated: number;
  /** Duration in ms. */
  durationMs: number;
};

/**
 * Run the opinion-confidence reflect pass.
 *
 * For every opinion in the Bank:
 * 1. Look up the originating fact to get base confidence.
 * 2. FTS-search for related facts (entity overlap required).
 * 3. Categorize: world/experience → supporting; conflicting opinions → contradicting.
 * 4. Recalculate confidence and persist.
 */
export function reflectOpinions(store: BankIndexStore): ReflectOpinionResult {
  const start = Date.now();
  const opinions = store.listOpinions();
  let updated = 0;

  for (const opinion of opinions) {
    if (updateOpinionEvidence(store, opinion)) {
      updated++;
    }
  }

  return {
    opinionsProcessed: opinions.length,
    opinionsUpdated: updated,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function updateOpinionEvidence(store: BankIndexStore, opinion: OpinionEntry): boolean {
  if (!store.ftsAvailable) {
    return false;
  }

  // Extract key terms for FTS search
  const searchTerms = extractSearchTerms(opinion.statement);
  if (!searchTerms) {
    return false;
  }

  // Query related facts via full-text search
  const results = store.recall({ text: searchTerms, limit: 50 });

  // Build evidence lists
  const supporting: string[] = [opinion.id]; // The opinion's own fact is always supporting
  const contradicting: string[] = [];

  for (const { fact } of results) {
    // Skip the opinion's own fact
    if (fact.id === opinion.id) {
      continue;
    }

    // Require entity overlap for relevance (unless the opinion has no entities)
    if (opinion.entities.length > 0) {
      const hasOverlap = fact.entities.some((e) => opinion.entities.includes(e));
      if (!hasOverlap) {
        continue;
      }
    }

    if (fact.kind === "world" || fact.kind === "experience" || fact.kind === "summary") {
      // Factual evidence that corroborates the opinion
      supporting.push(fact.id);
    } else if (fact.kind === "opinion" && fact.id !== opinion.id) {
      // Another opinion on the same topic — if its confidence is on the
      // opposite end of the spectrum, count it as contradicting.
      const otherConfidence = fact.confidence ?? 0.5;
      if (Math.abs(otherConfidence - opinion.confidence) > 0.4) {
        contradicting.push(fact.id);
      }
    }
  }

  // Retrieve original base confidence from the source fact
  const baseConfidence = getBaseConfidence(store, opinion);

  // Apply formula: new = base * (1 + 0.1*supports - 0.15*contradictions)
  const supports = supporting.length - 1; // exclude self
  const contradictions = contradicting.length;
  const rawConfidence = baseConfidence * (1 + 0.1 * supports - 0.15 * contradictions);
  const newConfidence = clamp(rawConfidence, 0.05, 0.99);

  // Check if anything actually changed
  const confidenceChanged = Math.abs(newConfidence - opinion.confidence) > 0.001;
  const supportChanged = !arraysEqual(opinion.supportingFacts, supporting);
  const contradictChanged = !arraysEqual(opinion.contradictingFacts, contradicting);

  if (!confidenceChanged && !supportChanged && !contradictChanged) {
    return false;
  }

  // Persist updated opinion
  store.upsertOpinion({
    ...opinion,
    confidence: newConfidence,
    supportingFacts: supporting,
    contradictingFacts: contradicting,
    lastUpdated: new Date().toISOString().slice(0, 10),
  });

  return true;
}

/**
 * Get the original confidence from the fact that generated this opinion.
 * Falls back to 0.5 if the originating fact is missing.
 */
function getBaseConfidence(store: BankIndexStore, opinion: OpinionEntry): number {
  const rows = store.db
    .prepare("SELECT confidence FROM facts WHERE id = ?")
    .all(opinion.id) as Array<{ confidence: number | null }>;

  if (rows.length > 0 && rows[0].confidence != null) {
    return rows[0].confidence;
  }
  // Fallback: use 0.5 if the originating fact was deleted or had no confidence
  return 0.5;
}

/**
 * Extract meaningful search terms from an opinion statement.
 * Strips stop words and keeps the top N content words.
 */
function extractSearchTerms(statement: string): string {
  const words = statement
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Take up to 6 key words for a broad-but-relevant search
  return words.slice(0, 6).join(" ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].toSorted();
  const sortedB = [...b].toSorted();
  return sortedA.every((v, i) => v === sortedB[i]);
}

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
