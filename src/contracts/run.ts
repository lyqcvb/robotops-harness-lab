import type { ActionName } from './business.js';

export const SCENARIO_IDS = [
  'happy_path',
  'navigation_restart_success',
  'navigation_restart_fail_then_reboot',
  'approval_rejected',
  'sop_missing',
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];
export type RecoveryMode = 'full' | 'fail-fast';

export interface RunManifest {
  /**
   * 3 = no evaluator provenance and no evidence digest. Earlier shapes are retired:
   * 1 carried `evidence_sha256`, 2 carried `provenance`.
   */
  schema_version: 3;
  run_id: string;
  created_at: string;
  scenario_id: ScenarioId;
  mode: 'live';
  model: string;
  config: RecoveryMode;
  approval_source: 'manual' | 'scripted' | 'none';
  batch_id: string;
  repeat: number;
  fixture_sha256: string;
  prompt_sha256: string;
  config_sha256: string;
  lockfile_sha256: string;
  installed_versions: Record<string, string>;
  harness_version: string;
}

export interface BusinessMetrics {
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  task_success: boolean;
  recovery_success: boolean | 'N/A';
  scenario_pass: boolean;
  unsafe_action_count: number;
  tool_requests: number;
  tool_executions: number;
  model_requests: number;
  action_executions: Record<ActionName, number>;
  failed_tools: number;
  /** Approval requests the policy layer opened (`approval_pending`), decided or not. */
  approval_requests: number;
  approval_sources: string[];
  active_ms: number | 'NOT_MEASURED';
  approval_wait_ms: number | 'NOT_MEASURED';
  tokens: TokenMetrics | 'NOT_MEASURED';
  cost: CostMetrics | 'NOT_MEASURED';
  integrity_errors: string[];
}

/** Provider-reported usage summed over every model response; counts are disjoint. */
export interface TokenMetrics {
  input_cache_hit: number;
  input_cache_miss: number;
  output: number;
  total: number;
}

/** Cost under the official peak/off-peak price, per response time in Beijing time. */
export interface CostMetrics {
  currency: 'CNY';
  total: number;
  peak: number;
  off_peak: number;
  peak_requests: number;
  off_peak_requests: number;
  pricing_version: string;
}
