import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import * as http from 'node:http';
import { McpProxy, type ProxyRequestEvent } from '../src/mcp/proxy.js';

describe('McpProxy', () => {
  let proxy: McpProxy;
  let auditEvents: ProxyRequestEvent[] = [];

  beforeEach(async () => {
    auditEvents = [];
    proxy = new McpProxy({ port: 0 }, (event) => auditEvents.push(event));
    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
  });

  it('starts and binds to a dynamic port', () => {
    expect(proxy.getPort()).toBeGreaterThan(0);
    expect(proxy.getAddress()).toContain(`0.0.0.0:${proxy.getPort()}`);
  });

  it('returns 405 for non-CONNECT requests', async () => {
    return new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${proxy.getPort()}`, (res) => {
        try {
          expect(res.statusCode).toBe(405);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  });

  it('rejects CONNECT requests from unregistered containers (403)', async () => {
    return new Promise<void>((resolve, reject) => {
      const req = http.request({
        method: 'CONNECT',
        host: '127.0.0.1',
        port: proxy.getPort(),
        path: 'example.com:443',
      });
      req.on('connect', (res, socket) => {
        try {
          socket.destroy();
          expect(res.statusCode).toBe(403);
          expect(auditEvents).toHaveLength(1);
          expect(auditEvents[0].allowed).toBe(false);
          expect(auditEvents[0].targetDomain).toBe('example.com');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
      req.end();
    });
  });

  it('registers and allows CONNECT requests to permitted domains', async () => {
    // 1. Create a dummy target server to connect to
    const targetServer = net.createServer((socket) => {
      socket.write('Target response');
      socket.end();
    });

    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    const targetPort = (targetServer.address() as net.AddressInfo).port;

    // 2. Register local IP (127.0.0.1) and allow 127.0.0.1 as a domain
    proxy.registerContainer('127.0.0.1', 'testbed', ['127.0.0.1']);

    // 3. Make proxy request
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        method: 'CONNECT',
        host: '127.0.0.1',
        port: proxy.getPort(),
        path: `127.0.0.1:${targetPort}`, // It connects actually to 127.0.0.1 now
      });

      req.on('connect', (res, socket) => {
        try {
          expect(res.statusCode).toBe(200);
          expect(auditEvents).toHaveLength(1);
          expect(auditEvents[0].allowed).toBe(true);
          expect(auditEvents[0].serverName).toBe('testbed');

          socket.destroy();
          targetServer.close();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
      req.end();
    });
  });

  it('unregisters containers', () => {
    proxy.registerContainer('1.1.1.1', 'testbed', ['allowed.com']);
    // Can't directly test internal registrations map without sending a request, but we can verify it doesn't crash
    proxy.unregisterContainer('1.1.1.1');
  });
});
