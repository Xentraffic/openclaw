/**
 * Bank memory subsystem — Retain / Recall / Reflect.
 *
 * Structured memory layer built on top of daily Markdown logs.
 */

export { BankIndexStore } from "./index-store.js";
export { openRecall, RecallSession, formatRecallResults, type RecallOptions } from "./recall.js";
export { ingestRetainFacts, type IngestOptions, type IngestResult } from "./retain-ingest.js";
export { extractDateFromFilename, parseRetainSections } from "./retain-parser.js";
export { reflectOpinions, type ReflectOpinionResult } from "./reflect.js";
export { reflectEntities, type ReflectEntitiesResult } from "./reflect-entities.js";
export { reflectSynthesis, type ReflectSynthesisResult } from "./reflect-synthesis.js";
export {
  runReflect,
  reflectCli,
  type ReflectRunnerOptions,
  type ReflectRunnerResult,
} from "./reflect-runner.js";
export type {
  BankStatus,
  EntityPage,
  FactEntry,
  FactKind,
  OpinionEntry,
  RecallQuery,
  RecallResult,
  RetainLine,
} from "./types.js";
