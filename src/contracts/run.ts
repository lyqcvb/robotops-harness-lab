import type { ActionName } from './business.js';
import type { RunProvenance } from './provenance.js';

export const SCENARIO_IDS = [
  'happy_path',
  'navigation_restart_success',
  'navigation_restart_fail_then_reboot',
  'approval_rejected',
  'sop_missing',
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];
export type RecoveryMode = 'full' | 'fail-fast';

interface RunManifestBase {
  run_id: string;
  created_at: string;
  scenario_id: ScenarioId;
  mode: 'offline' | 'live';
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
  /**
   * sha256 over the exact stored text of `business-events.jsonl` and
   * `native-events.jsonl`. The event streams are the actual proof of what a run did,
   * so they are sealed at write time and re-verified at read time. Absent on runs
   * recorded before evidence attestation existed; such runs are reported as
   * UNVERIFIED rather than silently treated as trustworthy.
   */
  evidence_sha256?: string;
}

export interface RunManifestV1 extends RunManifestBase {
  schema_version: 1;
  provenance?: never;
}

export interface RunManifestV2 extends RunManifestBase {
  schema_version: 2;
  provenance: RunProvenance;
}

export type RunManifest = RunManifestV1 | RunManifestV2;

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
  approval_sources: string[];
  active_ms: number | 'NOT_MEASURED';
  approval_wait_ms: number | 'NOT_MEASURED';
  tokens: 'NOT_MEASURED';
  cost: 'NOT_MEASURED';
  integrity_errors: string[];
}
