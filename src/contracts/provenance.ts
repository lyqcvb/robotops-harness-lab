export const EVALUATOR_VERSION = 'business-evaluator-v2' as const;

export interface ArtifactFingerprint {
  readonly sha256: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}

export interface RunProvenance {
  readonly schema_version: 1;
  readonly basis: 'compiled-javascript';
  readonly code: ArtifactFingerprint;
  readonly evaluator: ArtifactFingerprint & {
    readonly version: string;
  };
}
