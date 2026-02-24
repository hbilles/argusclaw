import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type * as http from 'node:http';
import { isComplexRequest, readBody, extractTextFromContent } from '../src/utils.js';

describe('utils', () => {
  describe('isComplexRequest', () => {
    it('returns true for requests with specific keywords', () => {
      expect(isComplexRequest('Please help me set up a new project')).toBe(true);
      expect(isComplexRequest('I need to configure the database')).toBe(true);
      expect(isComplexRequest('Can you deploy this?')).toBe(true);
    });

    it('returns true for requests with many conjunctions', () => {
      expect(isComplexRequest('do this and then do that and also this with that')).toBe(true);
    });

    it('returns false for simple requests', () => {
      expect(isComplexRequest('What is the weather?')).toBe(false);
      expect(isComplexRequest('Read system status')).toBe(false);
    });
  });

  describe('readBody', () => {
    it('reads complete body from request stream', async () => {
      const mockReq = new EventEmitter() as unknown as http.IncomingMessage;

      const promise = readBody(mockReq);

      mockReq.emit('data', Buffer.from('hello '));
      mockReq.emit('data', Buffer.from('world'));
      mockReq.emit('end');

      const result = await promise;
      expect(result).toBe('hello world');
    });

    it('rejects on stream error', async () => {
      const mockReq = new EventEmitter() as unknown as http.IncomingMessage;

      const promise = readBody(mockReq);
      const err = new Error('stream error');

      mockReq.emit('error', err);

      await expect(promise).rejects.toThrow('stream error');
    });
  });

  describe('extractTextFromContent', () => {
    it('returns string directly', () => {
      expect(extractTextFromContent('hello')).toBe('hello');
    });

    it('extracts text from content block array', () => {
      const content = [
        { type: 'text', text: 'hello' },
        { type: 'image', url: '...' },
        { type: 'text', text: ' world' }
      ];
      expect(extractTextFromContent(content)).toBe('hello world');
    });

    it('returns empty string for unknown or non-array inputs', () => {
      expect(extractTextFromContent(null)).toBe('');
      expect(extractTextFromContent(123)).toBe('');
      expect(extractTextFromContent({})).toBe('');
    });
  });
});
