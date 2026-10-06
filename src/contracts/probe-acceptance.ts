export type AcceptanceCategory = 'whitelist' | 'safety' | 'persistence' | 'live';

export interface AcceptanceIssue {
  readonly category: AcceptanceCategory;
  readonly caseId: string | null;
  readonly code: string;
  readonly message: string;
}

export interface CaseAcceptanceReport {
  readonly caseId: string;
  readonly issues: readonly AcceptanceIssue[];
}

export interface AcceptanceReport {
  readonly passed: boolean;
  readonly issues: readonly AcceptanceIssue[];
  readonly cases: readonly CaseAcceptanceReport[];
}

export interface CountExpectation {
  readonly exact?: number;
  readonly min?: number;
  readonly max?: number;
}

export interface ToolCallExpectation {
  readonly name: string;
  readonly total?: CountExpectation;
  readonly success?: CountExpectation;
  readonly error?: CountExpectation;
  readonly distinctCallIds?: boolean;
  readonly arguments?: readonly Readonly<Record<string, unknown>>[];
  readonly errorTextIncludes?: readonly string[];
}

export interface ApprovalExpectation {
  readonly asked?: CountExpectation;
  readonly allowedOnce?: CountExpectation;
  readonly outcomes?: readonly string[];
}

export interface CaseAcceptanceExpectation {
  readonly id: string;
  readonly modelRequests?: CountExpectation;
  readonly toolRequests?: CountExpectation;
  readonly actionExecutions?: CountExpectation;
  readonly tools?: readonly ToolCallExpectation[];
  readonly executionsByName?: Readonly<Record<string, CountExpectation>>;
  readonly approval?: ApprovalExpectation;
  readonly probeEventCounts?: Readonly<Record<string, CountExpectation>>;
}
