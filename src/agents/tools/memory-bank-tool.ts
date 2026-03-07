/**
 * Agent tool: memory_recall
 *
 * Structured recall from the Bank memory subsystem.
 * Supports text search, entity filter, temporal range, kind filter.
 *
 * Follows the same pattern as the existing memory_search tool in memory-tool.ts.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveAgentWorkspaceDir } from "../agent-scope.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemoryRecallSchema = Type.Object({
  query: Type.Optional(Type.String({ description: "Free-text search terms" })),
  entity: Type.Optional(
    Type.String({ description: "Filter by entity slug (e.g. 'Peter', 'warelay')" }),
  ),
  since: Type.Optional(
    Type.String({ description: "Only facts on or after this date (YYYY-MM-DD)" }),
  ),
  until: Type.Optional(
    Type.String({ description: "Only facts on or before this date (YYYY-MM-DD)" }),
  ),
  kind: Type.Optional(
    Type.String({
      description:
        "Fact kind filter: 'world', 'experience', 'opinion', 'summary' (comma-separated for multiple)",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max results (default 25)" })),
  includeEntitySummary: Type.Optional(
    Type.Boolean({
      description: "Include entity page summary when filtering by entity (default false)",
    }),
  ),
});

export function createMemoryRecallTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }

  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);

  return {
    label: "Memory Recall",
    name: "memory_recall",
    description:
      "Recall structured facts from the memory bank. Searches retained facts from daily logs " +
      "with optional filters: entity (@slug), date range (since/until), fact kind " +
      "(world/experience/opinion/summary), and free-text search. Returns facts with " +
      "source citations. Use this when you need to remember specific facts, preferences, " +
      "or past events about people or topics.",
    parameters: MemoryRecallSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query");
      const entity = readStringParam(params, "entity");
      const since = readStringParam(params, "since");
      const until = readStringParam(params, "until");
      const kindRaw = readStringParam(params, "kind");
      const limit = readNumberParam(params, "limit");
      const includeEntitySummary =
        params && typeof params === "object" && "includeEntitySummary" in params
          ? Boolean((params as Record<string, unknown>).includeEntitySummary)
          : false;

      try {
        // Dynamic import to avoid circular deps
        const { openRecall, formatRecallResults } = await import("../../memory/bank/recall.js");

        const session = await openRecall({ workspaceDir });

        try {
          const entities = entity
            ? entity
                .split(",")
                .map((e) => e.trim())
                .filter(Boolean)
            : undefined;

          const kinds = kindRaw
            ? (kindRaw
                .split(",")
                .map((k) => k.trim())
                .filter(Boolean) as Array<"world" | "experience" | "opinion" | "summary">)
            : undefined;

          const results = session.recall({
            text: query ?? undefined,
            entities,
            since: since ?? undefined,
            until: until ?? undefined,
            kinds,
            limit: limit ?? 25,
          });

          // Enrich with opinion data from Reflect
          const opinions = entities ? entities.flatMap((e) => session.getEntityOpinions(e)) : [];

          const formatted = formatRecallResults(
            results,
            opinions.length > 0 ? opinions : undefined,
          );
          const status = session.status();

          // Build response
          const response: Record<string, unknown> = {
            results: results.map((r) => ({
              kind: r.fact.kind,
              content: r.fact.content,
              entities: r.fact.entities,
              date: r.fact.sourceDate,
              source: `${r.fact.sourceFile}#L${r.fact.sourceLine}`,
              confidence: r.fact.confidence,
              score: r.score,
            })),
            count: results.length,
            totalFacts: status.facts,
            formatted,
          };

          // Include entity page summary if requested
          if (includeEntitySummary && entities?.length) {
            const entitySummaries: Record<string, string> = {};
            for (const e of entities) {
              const page = await session.getEntityPage(e);
              if (page) {
                entitySummaries[e] = page;
              }
            }
            if (Object.keys(entitySummaries).length > 0) {
              response.entitySummaries = entitySummaries;
            }
          }

          return jsonResult(response);
        } finally {
          session.close();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({
          results: [],
          count: 0,
          error: message,
          disabled: true,
        });
      }
    },
  };
}
