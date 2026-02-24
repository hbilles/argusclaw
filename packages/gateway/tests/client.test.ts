import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { McpClient } from '../src/mcp/client.js';

describe('McpClient', () => {
  let stdin: PassThrough;
  let stdout: PassThrough;
  let client: McpClient;

  beforeEach(() => {
    stdin = new PassThrough();
    stdout = new PassThrough();
    client = new McpClient(stdin, stdout);
  });

  it('can be constructed with valid streams', () => {
    expect(client).toBeDefined();
  });

  it('sends JSON-RPC messages to stdin and processes valid JSON from stdout', async () => {
    // We mock the internals of @modelcontextprotocol/sdk indirectly
    // By providing streams and spying on what gets written to stdin

    // When we call listTools() it should send a request
    stdin.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test-server", version: "1.0.0" }
            }
          }) + '\n');
        } else if (req.method === 'tools/list') {
          stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              tools: [
                { name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }
              ]
            }
          }) + '\n');
        }
      }
    });

    await client.initialize();

    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test_tool');
    expect(tools[0].description).toBe('A test tool');
  });

  it('can execute tools and return normalized result', async () => {
    stdin.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              serverInfo: { name: "test-server", version: "1.0.0" }
            }
          }) + '\n');
        } else if (req.method === 'tools/call') {
          stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              content: [{ type: "text", text: "Tool succeeded" }],
              isError: false
            }
          }) + '\n');
        }
      }
    });

    await client.initialize();
    const result = await client.callTool('test_tool', { arg: 'value' });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe('Tool succeeded');
  });
});
