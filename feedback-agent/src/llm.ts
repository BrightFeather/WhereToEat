import OpenAI from 'openai';
import { config, requireSecret } from './config.js';

export const llm = new OpenAI({
  apiKey: requireSecret('DEEP_SEEK_API'),
  baseURL: config.deepseekBaseUrl,
});

type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface CompleteArgs {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface CompleteResult {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// DeepSeek v4 defaults to thinking-on; we always disable it for this agent.
// See docs/architecture.md "Thinking mode is OFF by default".
export async function complete(args: CompleteArgs): Promise<CompleteResult> {
  const res = await llm.chat.completions.create(
    {
      model: args.model,
      messages: args.messages,
      temperature: args.temperature ?? 0,
      max_tokens: args.maxTokens ?? 512,
      // @ts-expect-error — DeepSeek-specific; OpenAI SDK passes unknown fields through
      thinking: { type: 'disabled' },
    },
  );
  const choice = res.choices[0];
  const content = choice?.message?.content ?? '';
  return {
    content: content.trim(),
    usage: {
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      totalTokens: res.usage?.total_tokens ?? 0,
    },
  };
}
