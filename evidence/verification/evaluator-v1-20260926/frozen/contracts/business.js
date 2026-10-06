import { TOOL_NAMES } from './stage0/constants.js';
export { TOOL_NAMES };
export const ROBOT_STATES = [
    'IDLE',
    'MOVING',
    'ERROR',
    'REBOOTING',
    'CHARGING',
    'OFFLINE',
];
export const TASK_STATES = [
    'PENDING',
    'RUNNING',
    'PAUSED',
    'FAILED',
    'COMPLETED',
];
export const DEFAULT_FIXTURE = {
    robots: [
        {
            robot_id: 'R-03',
            state: 'ERROR',
            battery: 31,
            error_code: 'NAV_042',
            current_task: 'TASK-502',
        },
    ],
    tasks: [
        {
            task_id: 'TASK-502',
            robot_id: 'R-03',
            status: 'PAUSED',
        },
    ],
};
export const DEFAULT_FAILURES = {
    restart_navigation: ['TIMEOUT', 'TIMEOUT'],
    force_reboot: ['SUCCESS'],
};
