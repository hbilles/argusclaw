
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
// Translation: Provider-Agnostic → Gemini
// ---------------------------------------------------------------------------

function toGeminiTool(tool: ToolDefinition): any {
  return {
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: tool.parameters.properties,
          required: tool.parameters.required,
        },
      },
    ],
  };
}

function toGeminiMessage(msg: ChatMessage): any {
  if (msg.role === 'user') {
    return { role: 'user', parts: [{ text: msg.content as string }] };
  }

  if (msg.role === 'tool_results') {
    const blocks = msg.content as ToolResultContent[];
    return {
      role: 'user', // Gemini requires function responses to be sent as the user or model role, actually role: 'user' or just role: 'function' depending on SDK version. Wait, in @google/genai role is 'user' for function response
      parts: blocks.map((block) => ({
        functionResponse: {
          name: block.toolCallId, // In Gemini, tool call ID typically matches the name or we need to align it, wait, let's look at the structure.
          response: { result: block.content },
        },
      })),
    };
  }

  if (typeof msg.content === 'string') {
    return { role: 'model', parts: [{ text: msg.content }] };
  }

  const contentBlocks = msg.content as ContentBlock[];
  return {
    role: 'model',
    parts: contentBlocks.map((block) => {
      if (block.type === 'text') {
        return { text: (block as TextContent).text };
      }
      const tc = block as ToolCallContent;
      return {
        functionCall: {
          name: tc.name,
          args: tc.input,
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Translation: Gemini → Provider-Agnostic
// ---------------------------------------------------------------------------

function fromGeminiResponse(response: any): LLMResponse {
  const candidate = response.candidates?.[0];
  if (!candidate || !candidate.content) {
    return { content: [], stopReason: 'unknown' };
  }

  const content: ContentBlock[] = [];
  const parts = candidate.content.parts || [];

  for (const part of parts) {
    if (part.text) {
      content.push({ type: 'text', text: part.text });
    } else if (part.functionCall) {
      let args = part.functionCall.args;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = { _raw: args };
        }
      } else if (args === null || args === undefined) {
        args = {};
      }
      content.push({
        type: 'tool_call',
        id: part.functionCall.name, // GenAI doesn't have explicit call IDs in some v1 responses, we use name temporarily
        name: part.functionCall.name,
        input: args,
      });
    }
  }

  let stopReason: StopReason = 'unknown';
  const finishReason = candidate.finishReason;
  if (finishReason === 'STOP') {
    stopReason = content.some(c => c.type === 'tool_call') ? 'tool_use' : 'end_turn';
  } else if (finishReason === 'MAX_TOKENS') {
    stopReason = 'max_tokens';
  }

  return {
    content,
    stopReason,
    usage: response.usageMetadata
      ? {
        inputTokens: response.usageMetadata.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata.candidatesTokenCount ?? 0,
      }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface GeminiProviderOptions {
  apiKey?: string;
}

export class GeminiProvider implements LLMProvider {
  private aiInstance: any | null = null;
  private options: GeminiProviderOptions;
  readonly name = 'gemini';

  constructor(options: GeminiProviderOptions = {}) {
    this.options = options;
  }

  private async getAI(): Promise<any> {
    if (this.aiInstance) return this.aiInstance;

    const { GoogleGenAI } = await import('@google/genai');
    const apiKey = this.options.apiKey ?? process.env['GEMINI_API_KEY'];
    if (!apiKey) {
      console.warn('GeminiProvider initialized without API key');
    }

    this.aiInstance = new GoogleGenAI(apiKey ? { apiKey } : {});
    return this.aiInstance;
  }

  async chat(params: {
    model: string;
    maxTokens: number;
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse> {
    const contents = params.messages.map(toGeminiMessage);
    const tools = params.tools.map(toGeminiTool);

    const ai = await this.getAI();
    const response = await ai.models.generateContent({
      model: params.model,
      contents,
      config: {
        systemInstruction: params.system ? { role: 'system', parts: [{ text: params.system }] } : undefined,
        tools: tools.length > 0 ? tools : undefined,
        maxOutputTokens: params.maxTokens,
      },
    });

    return fromGeminiResponse(response);
  }
}
