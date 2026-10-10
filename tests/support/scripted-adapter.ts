import {
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';

import type { ScenarioId, RecoveryMode } from '../../src/contracts/run.js';

/**
 * Test-only model for keyless runtime regression tests. It replays fixed tool calls
 * through the real native loop, policy layer and approval chain; it is never reachable
 * from a CLI run.
 */
export interface ScriptedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type ScriptedTurn =
  | { readonly kind: 'tool-calls'; readonly calls: readonly ScriptedToolCall[] }
  | { readonly kind: 'text'; readonly text: string };

function abortedFinish(): StreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'aborted',
      failure: { message: 'scripted model request aborted', code: 'ABORTED' },
    },
  };
}

export class ScriptedAdapter extends LlmAdapter {
  private requestIndex = 0;

  constructor(private readonly turns: readonly ScriptedTurn[]) {
    super();
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Scripted test adapter' };
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: `Scripted ${model}`, inputModalities: ['text'] });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const turn = this.turns[this.requestIndex] ?? { kind: 'text', text: 'scripted run complete' };
    this.requestIndex += 1;

    if (options.signal?.aborted) {
      yield abortedFinish();
      return;
    }

    if (turn.kind === 'tool-calls') {
      for (const [index, call] of turn.calls.entries()) {
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield {
          type: 'block-end',
          index,
          block: {
            type: 'tool-call',
            id: ToolCallId(call.id),
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        };
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }

    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: turn.text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

const ROBOT_ID = 'R-03';
const TASK_ID = 'TASK-502';

/** The tool-call sequence a correct agent issues for each scenario × config. */
export function scenarioTurns(scenarioId: ScenarioId, config: RecoveryMode): readonly ScriptedTurn[] {
  let index = 0;
  const call = (name: string, args: Readonly<Record<string, unknown>>): ScriptedToolCall => {
    index += 1;
    return { id: `${scenarioId}-call-${index}`, name, arguments: args };
  };
  const robot = () => call('get_robot_status', { robot_id: ROBOT_ID });
  const task = () => call('get_task_status', { task_id: TASK_ID });
  const sop = (errorCode: string) => call('search_sop', { error_code: errorCode });
  const restart = () => call('restart_navigation', { robot_id: ROBOT_ID });
  const force = () => call('force_reboot', { robot_id: ROBOT_ID });
  const resume = () => call('resume_task', { robot_id: ROBOT_ID, task_id: TASK_ID });
  const ticket = (reason: string) => call('create_maintenance_ticket', { robot_id: ROBOT_ID, reason });
  const failFast = () => [robot(), task(), sop('NAV_042'), restart(), ticket('fail-fast: 首次 restart_navigation 失败后停止恢复动作')];

  let calls: ScriptedToolCall[];
  switch (scenarioId) {
    case 'happy_path':
      calls = [robot(), task(), resume(), robot(), task()];
      break;
    case 'navigation_restart_success':
      calls = [robot(), task(), sop('NAV_042'), restart(), robot(), task(), resume(), robot(), task()];
      break;
    case 'navigation_restart_fail_then_reboot':
      calls = config === 'fail-fast'
        ? failFast()
        : [robot(), task(), sop('NAV_042'), restart(), restart(), force(), robot(), task(), resume(), robot(), task()];
      break;
    case 'approval_rejected':
      calls = config === 'fail-fast'
        ? failFast()
        : [robot(), task(), sop('NAV_042'), restart(), restart(), force(), ticket('force_reboot 审批被拒绝，机器人保持故障状态')];
      break;
    case 'sop_missing':
      calls = [robot(), task(), sop('UNKNOWN_999'), ticket('SOP 缺失，无法确认恢复步骤')];
      break;
  }
  return [
    ...calls.map((item): ScriptedTurn => ({ kind: 'tool-calls', calls: [item] })),
    { kind: 'text', text: '结论只依据工具返回与真实状态读取。' },
  ];
}
