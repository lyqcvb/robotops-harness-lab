// Types shared by the business runtime and the probe; neither side owns them.

export interface SafeError {
  readonly type: string;
  readonly name: string;
  readonly code: string | null;
  readonly message: string;
}
