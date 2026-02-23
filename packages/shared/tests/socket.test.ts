/**
 * Integration tests for the Unix domain socket server and client.
 *
 * Tests cover:
 * - Server startup and shutdown
 * - Client connection and disconnection
 * - JSON-lines message exchange
 * - Client reconnection logic
 * - Server broadcast to multiple clients
 * - Connection events
 */

import { describe, it, expect, afterEach } from 'vitest';
import { SocketServer, SocketClient } from '../src/socket.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Generate a unique socket path in /tmp for test isolation. */
function tmpSocketPath(): string {
  return path.join(os.tmpdir(), `argusclaw-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

// Track servers/clients for cleanup
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  // Cleanup all resources in reverse order
  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch { /* ignore */ }
  }
  cleanup.length = 0;
});

// ---------------------------------------------------------------------------
// SocketServer
// ---------------------------------------------------------------------------

describe('SocketServer', () => {
  it('should start and listen on the socket path', async () => {
    const socketPath = tmpSocketPath();
    const server = new SocketServer(socketPath);
    cleanup.push(() => server.stop());

    await server.start();

    // Verify socket file was created
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('should remove stale socket file on start', async () => {
    const socketPath = tmpSocketPath();

    // Create a stale socket file
    fs.writeFileSync(socketPath, '');
    expect(fs.existsSync(socketPath)).toBe(true);

    const server = new SocketServer(socketPath);
    cleanup.push(() => server.stop());

    // Should not throw
    await server.start();
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('should clean up on stop', async () => {
    const socketPath = tmpSocketPath();
    const server = new SocketServer(socketPath);

    await server.start();
    await server.stop();

    // Server should have shut down cleanly
    // (socket file may or may not persist depending on OS)
  });

  it('should emit connection event when client connects', async () => {
    const socketPath = tmpSocketPath();
    const server = new SocketServer(socketPath);
    cleanup.push(() => server.stop());

    await server.start();

    const connectionPromise = new Promise<string>((resolve) => {
      server.on('connection', (clientId: string) => resolve(clientId));
    });

    const client = new SocketClient(socketPath);
    cleanup.push(() => client.disconnect());
    client.connect();

    const clientId = await connectionPromise;
    expect(typeof clientId).toBe('string');
    expect(clientId.length).toBeGreaterThan(0);
  });

  it('should emit disconnection event when client disconnects', async () => {
    const socketPath = tmpSocketPath();
    const server = new SocketServer(socketPath);
    cleanup.push(() => server.stop());

    await server.start();

    const connPromise = new Promise<void>((resolve) => {
      server.on('connection', () => resolve());
    });

    const disconnPromise = new Promise<string>((resolve) => {
      server.on('disconnection', (clientId: string) => resolve(clientId));
    });

    const client = new SocketClient(socketPath);
    client.connect();

    await connPromise;
    client.disconnect();

    const disconnectedId = await disconnPromise;
    expect(typeof disconnectedId).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// SocketClient
// ---------------------------------------------------------------------------

describe('SocketClient', () => {
  it('should report connected=false before connecting', () => {
    const client = new SocketClient(tmpSocketPath());
    expect(client.connected).toBe(false);
  });

  it('should connect to a running server', async () => {
    const socketPath = tmpSocketPath();
    const server = new SocketServer(socketPath);
    cleanup.push(() => server.stop());

    await server.start();

    const client = new SocketClient(socketPath);
    cleanup.push(() => client.disconnect());

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    client.connect();
    await connectedPromise;

    expect(client.connected).toBe(true);
  });

  it('should emit disconnected event on disconnect', async () => {
    const socketPath = tmpSocketPath();
    const server = new SocketServer(socketPath);
    cleanup.push(() => server.stop());

    await server.start();

    const client = new SocketClient(socketPath);

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    client.connect();
    await connectedPromise;

    const disconnectedPromise = new Promise<void>((resolve) => {
      client.on('disconnected', () => resolve());
    });

    client.disconnect();
    await disconnectedPromise;

    expect(client.connected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JSON-lines message exchange
// ---------------------------------------------------------------------------

describe('message exchange', () => {
  it('should deliver JSON messages from client to server', async () => {
    const socketPath = tmpSocketPath();
    const server = new SocketServer(socketPath);
    cleanup.push(() => server.stop());

    await server.start();

    const client = new SocketClient(socketPath);
    cleanup.push(() => client.disconnect());

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    client.connect();
    await connectedPromise;

    const messagePromise = new Promise<unknown>((resolve) => {
      server.on('message', (data) => resolve(data));
    });

    const testPayload = { type: 'test', content: 'hello from client', number: 42 };
    client.send(testPayload);

    const received = await messagePromise;
    expect(received).toEqual(testPayload);
  });

  it('should deliver JSON messages from server to client', async () => {
    const socketPath = tmpSocketPath();
    const server = new SocketServer(socketPath);
    cleanup.push(() => server.stop());

    await server.start();

    const client = new SocketClient(socketPath);
    cleanup.push(() => client.disconnect());

    let serverClientId = '';
    const connPromise = new Promise<void>((resolve) => {
      server.on('connection', (clientId) => {
        serverClientId = clientId;
        resolve();
      });
    });

    client.connect();
    await connPromise;

    const messagePromise = new Promise<unknown>((resolve) => {
      client.on('message', (data) => resolve(data));
    });

    const testPayload = { type: 'response', result: 'success' };
    server.send(serverClientId, testPayload);

    const received = await messagePromise;
    expect(received).toEqual(testPayload);
  });

  it('should handle reply function in server message handler', async () => {
    const socketPath = tmpSocketPath();
    const server = new SocketServer(socketPath);
    cleanup.push(() => server.stop());

    await server.start();

    const client = new SocketClient(socketPath);
    cleanup.push(() => client.disconnect());

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    client.connect();
    await connectedPromise;

    // Server echoes back the message
    server.on('message', (data, reply) => {
      reply({ echo: data });
    });

    const responsePromise = new Promise<unknown>((resolve) => {
      client.on('message', (data) => resolve(data));
    });

    client.send({ ping: true });

    const response = await responsePromise;
    expect(response).toEqual({ echo: { ping: true } });
  });

  it('should broadcast to all connected clients', async () => {
    const socketPath = tmpSocketPath();
    const server = new SocketServer(socketPath);
    cleanup.push(() => server.stop());

    await server.start();

    const client1 = new SocketClient(socketPath);
    const client2 = new SocketClient(socketPath);
    cleanup.push(() => client1.disconnect());
    cleanup.push(() => client2.disconnect());

    // Wait for both connections
    let connectionCount = 0;
    const bothConnected = new Promise<void>((resolve) => {
      server.on('connection', () => {
        connectionCount++;
        if (connectionCount === 2) resolve();
      });
    });

    const conn1 = new Promise<void>((r) => client1.on('connected', () => r()));
    const conn2 = new Promise<void>((r) => client2.on('connected', () => r()));

    client1.connect();
    client2.connect();

    await Promise.all([conn1, conn2, bothConnected]);

    // Set up message listeners
    const msg1Promise = new Promise<unknown>((resolve) => {
      client1.on('message', (data) => resolve(data));
    });
    const msg2Promise = new Promise<unknown>((resolve) => {
      client2.on('message', (data) => resolve(data));
    });

    // Broadcast
    const broadcastPayload = { type: 'broadcast', content: 'hello everyone' };
    server.broadcast(broadcastPayload);

    const [received1, received2] = await Promise.all([msg1Promise, msg2Promise]);
    expect(received1).toEqual(broadcastPayload);
    expect(received2).toEqual(broadcastPayload);
  });

  it('should handle multiple messages in sequence', async () => {
    const socketPath = tmpSocketPath();
    const server = new SocketServer(socketPath);
    cleanup.push(() => server.stop());

    await server.start();

    const client = new SocketClient(socketPath);
    cleanup.push(() => client.disconnect());

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    client.connect();
    await connectedPromise;

    const messages: unknown[] = [];
    const threeMessages = new Promise<void>((resolve) => {
      server.on('message', (data) => {
        messages.push(data);
        if (messages.length === 3) resolve();
      });
    });

    client.send({ seq: 1 });
    client.send({ seq: 2 });
    client.send({ seq: 3 });

    await threeMessages;

    expect(messages).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
  });
});

// ---------------------------------------------------------------------------
// Client reconnection
// ---------------------------------------------------------------------------

describe('client reconnection', () => {
  it('should reconnect after server restart', async () => {
    const socketPath = tmpSocketPath();
    const server1 = new SocketServer(socketPath);
    cleanup.push(() => server1.stop().catch(() => {}));

    await server1.start();

    const client = new SocketClient(socketPath);
    cleanup.push(() => client.disconnect());

    const firstConnect = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    client.connect();
    await firstConnect;
    expect(client.connected).toBe(true);

    // Stop the first server
    await server1.stop();

    // Wait for client to notice disconnect
    const disconnected = new Promise<void>((resolve) => {
      client.on('disconnected', () => resolve());
    });
    await disconnected;
    expect(client.connected).toBe(false);

    // Start a new server on the same path
    const server2 = new SocketServer(socketPath);
    cleanup.push(() => server2.stop());

    const reconnected = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    await server2.start();
    await reconnected;
    expect(client.connected).toBe(true);
  }, 15000);

  it('should not reconnect after explicit disconnect', async () => {
    const socketPath = tmpSocketPath();
    const server = new SocketServer(socketPath);
    cleanup.push(() => server.stop());

    await server.start();

    const client = new SocketClient(socketPath);

    const connectedPromise = new Promise<void>((resolve) => {
      client.on('connected', () => resolve());
    });

    client.connect();
    await connectedPromise;

    // Explicit disconnect (sets shouldReconnect = false)
    client.disconnect();
    expect(client.connected).toBe(false);

    // Wait a bit to ensure no reconnection
    await new Promise((r) => setTimeout(r, 1000));
    expect(client.connected).toBe(false);
  });

  it('should not send when disconnected', () => {
    const client = new SocketClient(tmpSocketPath());
    // Should not throw, but should warn
    client.send({ test: true });
    expect(client.connected).toBe(false);
  });
});
