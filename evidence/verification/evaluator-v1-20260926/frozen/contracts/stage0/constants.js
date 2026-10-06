export const HARNESS_VERSION = '0.1.5-rc.3';
export const TOOL_NAMES = [
    'get_robot_status',
    'get_task_status',
    'search_sop',
    'restart_navigation',
    'force_reboot',
    'resume_task',
    'create_maintenance_ticket',
];
export const DEFAULT_BUDGETS = {
    modelRequests: 20,
    toolCalls: 30,
    activeMs: 300000,
    approvalMs: 120000,
};
export const DEFAULT_MODEL = 'deepseek-flash';
