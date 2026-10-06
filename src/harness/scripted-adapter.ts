import {
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';

import type { ScriptedTurn } from '../contracts/probe.js';
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

  get requestCount(): number {
    return this.requestIndex;
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Stage 0 scripted probe adapter' };
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: `Stage 0 scripted ${model}`, inputModalities: ['text'] });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const turn = this.turns[this.requestIndex] ?? { kind: 'text', text: 'scripted probe complete' };
    this.requestIndex += 1;

    if (options.signal?.aborted) {
      yield abortedFinish();
      return;
    }

    if (turn.kind === 'tool-calls') {
      for (const [index, call] of turn.calls.entries()) {
        if (options.signal?.aborted) {
          yield abortedFinish();
          return;
        }
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

    if (options.signal?.aborted) {
      yield abortedFinish();
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: turn.text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

