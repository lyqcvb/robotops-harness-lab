export const TOOL_NAMES = Object.freeze([
  'get_robot_status',
  'get_task_status',
  'search_sop',
  'restart_navigation',
  'force_reboot',
  'resume_task',
  'create_maintenance_ticket',
] as const);

export type ToolName = (typeof TOOL_NAMES)[number];

export const RESULT_STATUSES = Object.freeze([
  'SUCCESS',
  'RETRYABLE_FAILURE',
  'FATAL_FAILURE',
  'DENIED',
] as const);

export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const TOOL_PARAMETERS: Readonly<Record<ToolName, readonly string[]>> =
  Object.freeze({
    get_robot_status: Object.freeze(['robot_id'] as const),
    get_task_status: Object.freeze(['task_id'] as const),
    search_sop: Object.freeze(['error_code'] as const),
    restart_navigation: Object.freeze(['robot_id'] as const),
    force_reboot: Object.freeze(['robot_id'] as const),
    resume_task: Object.freeze(['robot_id', 'task_id'] as const),
    create_maintenance_ticket: Object.freeze(['robot_id', 'reason'] as const),
  });

export const TOOL_PARAMETER_SCHEMAS = Object.freeze({
  get_robot_status: Object.freeze({
    robot_id: Object.freeze({ type: 'string', required: true } as const),
  }),
  get_task_status: Object.freeze({
    task_id: Object.freeze({ type: 'string', required: true } as const),
  }),
  search_sop: Object.freeze({
    error_code: Object.freeze({ type: 'string', required: true } as const),
  }),
  restart_navigation: Object.freeze({
    robot_id: Object.freeze({ type: 'string', required: true } as const),
  }),
  force_reboot: Object.freeze({
    robot_id: Object.freeze({ type: 'string', required: true } as const),
  }),
  resume_task: Object.freeze({
    robot_id: Object.freeze({ type: 'string', required: true } as const),
    task_id: Object.freeze({ type: 'string', required: true } as const),
  }),
  create_maintenance_ticket: Object.freeze({
    robot_id: Object.freeze({ type: 'string', required: true } as const),
    reason: Object.freeze({ type: 'string', required: true } as const),
  }),
} as const);

export const TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    status: Object.freeze({
      type: 'string',
      enum: RESULT_STATUSES,
      required: true,
    } as const),
    error_code: Object.freeze({
      oneOf: Object.freeze([
        Object.freeze({ type: 'string' } as const),
        Object.freeze({ type: 'null' } as const),
      ] as const),
      required: true,
    } as const),
    reason: Object.freeze({ type: 'string', required: true } as const),
    data: Object.freeze({ type: 'json', required: true } as const),
  }),
} as const);
