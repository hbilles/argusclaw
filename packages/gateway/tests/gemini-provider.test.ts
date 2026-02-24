import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateContentMock = vi.fn();
const constructorMock = vi.fn();

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContent: generateContentMock,
    };
    constructor(options: any) {
      constructorMock(options);
    }
  }
  return { GoogleGenAI };
});

import { GeminiProvider } from '../src/providers/gemini.js';

describe('GeminiProvider', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
    constructorMock.mockReset();

    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: { parts: [{ text: 'Hello from Gemini' }] },
          finishReason: 'STOP',
        }
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
      }
    });
  });

  it('translates simple user message correctly', async () => {
    const provider = new GeminiProvider({ apiKey: 'test-key' });

    const response = await provider.chat({
      model: 'gemini-2.5-flash',
      maxTokens: 100,
      system: 'You are a test bot',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
    });

    expect(response.content[0]).toEqual({ type: 'text', text: 'Hello from Gemini' });
    expect(response.stopReason).toBe('end_turn');
    expect(response.usage?.inputTokens).toBe(10);
    expect(response.usage?.outputTokens).toBe(5);

    expect(generateContentMock).toHaveBeenCalledTimes(1);
    expect(generateContentMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
    }));

    const callArgs = (generateContentMock.mock.calls[0] as any[])[0];
    expect(callArgs.config.systemInstruction.parts[0].text).toBe('You are a test bot');
    expect(callArgs.config.maxOutputTokens).toBe(100);
  });

  it('translates tool definitions and tool results correctly', async () => {
    const provider = new GeminiProvider({ apiKey: 'test-key' });

    generateContentMock.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'get_weather', args: { location: 'London' } } }
            ]
          },
          finishReason: 'STOP',
        }
      ]
    });

    const toolMsg1 = await provider.chat({
      model: 'gemini-2.5-flash',
      maxTokens: 100,
      system: '',
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          }
        }
      ],
    });

    expect(toolMsg1.stopReason).toBe('tool_use');
    expect(toolMsg1.content[0]).toEqual({
      type: 'tool_call',
      id: 'get_weather',
      name: 'get_weather',
      input: { location: 'London' }
    });

    const callArgs1 = (generateContentMock.mock.calls[0] as any[])[0];
    expect(callArgs1.config.tools[0].functionDeclarations[0].name).toBe('get_weather');

    // Test formatting of tool results back to Gemini
    generateContentMock.mockResolvedValueOnce({
      candidates: [
        {
          content: { parts: [{ text: 'It is raining.' }] },
          finishReason: 'STOP',
        }
      ]
    });

    await provider.chat({
      model: 'gemini-2.5-flash',
      maxTokens: 100,
      system: '',
      messages: [
        { role: 'user', content: 'Weather?' },
        { role: 'assistant', content: toolMsg1.content }, // includes tool call
        {
          role: 'tool_results', content: [
            { type: 'tool_result', toolCallId: 'get_weather', content: 'Raining' }
          ]
        }
      ],
      tools: [],
    });

    const callArgs2 = (generateContentMock.mock.calls[1] as any[])[0];
    expect(callArgs2.contents).toEqual([
      { role: 'user', parts: [{ text: 'Weather?' }] },
      { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { location: 'London' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { result: 'Raining' } } }] }
    ]);
  });
});
