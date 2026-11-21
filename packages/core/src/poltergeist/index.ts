/*
 * @ossuary/core/poltergeist: the fault injector and drift meter.
 * Browser-safe (design D8): apps run the storm live in the page on PGlite.
 * The CLI (cli.ts) is Node-only and is deliberately not exported here.
 */
export {
  generateStorm,
  stormToJson,
  isolateUnit,
  prefixStorm,
  GENERATOR_VERSION,
  DEFAULT_STORM_SIZE,
  MAX_STORM_SIZE,
  MEMBERS,
} from './storm.js';
export type {
  Storm,
  StormOptions,
  Unit,
  Ghost,
  HonestUnit,
  Step,
  PlannedDelivery,
  RailEvent,
  PayoutRequest,
  TruthEffect,
  MemberRef,
} from './storm.js';
export { FAULTS, FAULT_IDS, DEFENSE_LABELS, renderEpitaph, shortSubject } from './faults.js';
export type { Fault, FaultId, DefenseId } from './faults.js';
export { measureDrift, emptyTruth, addEffect } from './drift.js';
export type { Drift, DriftDelta, Truth, RefSnapshot } from './drift.js';
export { summon, PoltergeistRunError, STORM_EPOCH_MS, MAX_ATTEMPTS } from './summon.js';
export type { SummonOptions } from './summon.js';
export { ossuaryFactory } from './sut.js';
export { twinFactory } from './twinSut.js';
export type {
  SystemUnderTest,
  SutFactory,
  SutContext,
  DeliverOptions,
  DeliveryResult,
  BalanceSnapshot,
  Route,
  CrashPlan,
} from './sut.js';
export { REPORT_SCHEMA, REPORT_VERSION, serializeReport } from './report.js';
export type {
  PoltergeistReport,
  Target,
  DriftJson,
  FaultSummary,
  BlockedGhost,
  DriftedGhost,
  CounterexampleJson,
} from './report.js';
export { applyEmbeddedMigrations } from './migrate.js';
export { fakeClock } from './clock.js';
export type { FakeClock } from './clock.js';
