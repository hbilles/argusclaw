/**
 * OpenAI Codex LLM provider — wraps the OpenAI Responses API.
 *
 * Codex models (codex-mini-latest, gpt-5-codex, gpt-5.1-codex, gpt-5.2-codex)
 * are served via the Responses API, which has a different request/response
 * contract than the Chat Completions API used by the OpenAI provider.
 *
 * Translates between provider-agnostic types and the Responses API format.
 */

import OpenAI from 'openai';
import type {
  Response as OAIResponse,
  FunctionTool,
  EasyInputMessage,
  ResponseInputItem,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseOutputItem,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';
import type {
  LLMProvider,
  LLMResponse,
  ChatMessage,
  ToolDefinition,
  ContentBlock,
  TextContent,
  ToolCallContent,
  ToolResultContent,
  StopReason,
} from '../llm-provider.js';

// ---------------------------------------------------------------------------
// Translation: Provider-Agnostic → Responses API
// ---------------------------------------------------------------------------

function toCodexTool(tool: ToolDefinition): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false, // SecureClaw schemas lack additionalProperties: false
  };
}

/**
 * Convert the provider-agnostic message history into Responses API input items.
 *
 * Each ChatMessage maps to one or more ResponseInputItem entries:
 * - user text       → EasyInputMessage { role: 'user' }
 * - assistant text  → EasyInputMessage { role: 'assistant' }
 * - assistant blocks → EasyInputMessage (text) + ResponseFunctionToolCall (tool calls)
 * - tool_results    → ResponseInputItem.FunctionCallOutput per result
 */
function toCodexInput(messages: ChatMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      items.push({
        role: 'user',
        content: msg.content as string,
      } satisfies EasyInputMessage);
      continue;
    }

    if (msg.role === 'tool_results') {
      const blocks = msg.content as ToolResultContent[];
      for (const block of blocks) {
        items.push({
          type: 'function_call_output',
          call_id: block.toolCallId,
          output: block.content,
        });
      }
      continue;
    }

    // role === 'assistant'
    if (typeof msg.content === 'string') {
      items.push({
        role: 'assistant',
        content: msg.content,
      } satisfies EasyInputMessage);
      continue;
    }

    // Assistant message with ContentBlock[] — split text and tool calls
    const contentBlocks = msg.content as ContentBlock[];
    const textParts: string[] = [];

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        textParts.push((block as TextContent).text);
      } else if (block.type === 'tool_call') {
        const tc = block as ToolCallContent;
        items.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        } as ResponseFunctionToolCall);
      }
    }

    if (textParts.length > 0) {
      items.push({
        role: 'assistant',
        content: textParts.join(''),
      } satisfies EasyInputMessage);
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Translation: Responses API → Provider-Agnostic
// ---------------------------------------------------------------------------

function fromCodexResponse(response: OAIResponse): LLMResponse {
  const content: ContentBlock[] = [];
  let hasToolCalls = false;

  for (const item of response.output) {
    if (item.type === 'message') {
      const msg = item as ResponseOutputMessage;
      for (const part of msg.content) {
        if (part.type === 'output_text') {
          content.push({
            type: 'text',
            text: (part as ResponseOutputText).text,
          } satisfies TextContent);
        }
      }
    } else if (item.type === 'function_call') {
      hasToolCalls = true;
      const tc = item as ResponseFunctionToolCall;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        input = { _raw: tc.arguments };
      }
      content.push({
        type: 'tool_call',
        id: tc.call_id,
        name: tc.name,
        input,
      } satisfies ToolCallContent);
    }
    // Skip reasoning items and built-in tool types (web_search, etc.)
  }

  let stopReason: StopReason;
  if (hasToolCalls) {
    stopReason = 'tool_use';
  } else if (response.status === 'incomplete') {
    stopReason =
      response.incomplete_details?.reason === 'max_output_tokens'
        ? 'max_tokens'
        : 'unknown';
  } else if (response.status === 'completed') {
    stopReason = 'end_turn';
  } else {
    stopReason = 'unknown';
  }

  return {
    content,
    stopReason,
    usage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface CodexProviderOptions {
  apiKey?: string;
  baseURL?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export class CodexProvider implements LLMProvider {
  private client: OpenAI;
  private reasoningEffort?: 'low' | 'medium' | 'high';
  readonly name = 'codex';

  constructor(options: CodexProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'Codex provider requires OPENAI_API_KEY. ' +
          'Set it in your .env file or pass apiKey in provider options.',
      );
    }
    this.client = new OpenAI({ apiKey, baseURL: options.baseURL });
    this.reasoningEffort = options.reasoningEffort;
  }

  async chat(params: {
    model: string;
    maxTokens: number;
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse> {
    const input = toCodexInput(params.messages);

    const requestParams: ResponseCreateParamsNonStreaming = {
      model: params.model,
      instructions: params.system,
      input,
      max_output_tokens: params.maxTokens,
      store: false, // SecureClaw manages its own conversation state
    };

    // Only include tools if there are any
    if (params.tools.length > 0) {
      requestParams.tools = params.tools.map(toCodexTool);
    }

    // Reasoning effort for Codex/o-series models
    if (this.reasoningEffort) {
      requestParams.reasoning = {
        effort: this.reasoningEffort,
      };
    }

    const response = await this.client.responses.create(requestParams);

    return fromCodexResponse(response as OAIResponse);
  }
}
