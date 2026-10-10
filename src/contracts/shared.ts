// Types shared by the business runtime and the probe; neither side owns them.

export interface SafeError {
  readonly type: string;
  readonly name: string;
  readonly code: string | null;
  readonly message: string;
}

export interface ScriptedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type ScriptedTurn =
  | { readonly kind: 'tool-calls'; readonly calls: readonly ScriptedToolCall[] }
  | { readonly kind: 'text'; readonly text: string };
