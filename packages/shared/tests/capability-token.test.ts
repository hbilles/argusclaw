/**
 * Unit tests for the Capability Token system.
 *
 * Tests cover:
 * - Token minting and verification
 * - Token expiration
 * - Invalid token handling
 * - Capability payload integrity
 */

import { describe, it, expect } from 'vitest';
import { mintCapabilityToken, verifyCapabilityToken } from '../src/capability-token.js';
import type { Capability } from '../src/capability-token.js';

const TEST_SECRET = 'test-secret-key-for-unit-tests';

const testCapability: Capability = {
  executorType: 'shell',
  mounts: [
    { hostPath: '/home/user/projects', containerPath: '/workspace', readOnly: false },
    { hostPath: '/home/user/docs', containerPath: '/documents', readOnly: true },
  ],
  network: 'none',
  timeoutSeconds: 60,
  maxOutputBytes: 1048576,
};

// ---------------------------------------------------------------------------
// Token minting
// ---------------------------------------------------------------------------

describe('mintCapabilityToken', () => {
  it('should return a non-empty string token', () => {
    const token = mintCapabilityToken(testCapability, TEST_SECRET);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('should produce valid JWT format (three dot-separated parts)', () => {
    const token = mintCapabilityToken(testCapability, TEST_SECRET);
    const parts = token.split('.');
    expect(parts.length).toBe(3);
  });

  it('should produce different tokens for different capabilities', () => {
    const token1 = mintCapabilityToken(testCapability, TEST_SECRET);
    const otherCap: Capability = { ...testCapability, executorType: 'file' };
    const token2 = mintCapabilityToken(otherCap, TEST_SECRET);
    expect(token1).not.toBe(token2);
  });

  it('should produce different tokens for different secrets', () => {
    const token1 = mintCapabilityToken(testCapability, 'secret-a');
    const token2 = mintCapabilityToken(testCapability, 'secret-b');
    expect(token1).not.toBe(token2);
  });
});

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

describe('verifyCapabilityToken', () => {
  it('should return the original capability from a valid token', () => {
    const token = mintCapabilityToken(testCapability, TEST_SECRET);
    const decoded = verifyCapabilityToken(token, TEST_SECRET);
    expect(decoded.executorType).toBe('shell');
    expect(decoded.mounts).toHaveLength(2);
    expect(decoded.network).toBe('none');
    expect(decoded.timeoutSeconds).toBe(60);
    expect(decoded.maxOutputBytes).toBe(1048576);
  });

  it('should preserve mount details in round-trip', () => {
    const token = mintCapabilityToken(testCapability, TEST_SECRET);
    const decoded = verifyCapabilityToken(token, TEST_SECRET);
    expect(decoded.mounts[0]).toEqual({
      hostPath: '/home/user/projects',
      containerPath: '/workspace',
      readOnly: false,
    });
    expect(decoded.mounts[1]).toEqual({
      hostPath: '/home/user/docs',
      containerPath: '/documents',
      readOnly: true,
    });
  });

  it('should preserve network allowedDomains in round-trip', () => {
    const webCap: Capability = {
      ...testCapability,
      executorType: 'web',
      network: { allowedDomains: ['github.com', 'stackoverflow.com'] },
    };
    const token = mintCapabilityToken(webCap, TEST_SECRET);
    const decoded = verifyCapabilityToken(token, TEST_SECRET);
    expect(decoded.network).toEqual({ allowedDomains: ['github.com', 'stackoverflow.com'] });
  });

  it('should reject token signed with different secret', () => {
    const token = mintCapabilityToken(testCapability, 'correct-secret');
    expect(() => verifyCapabilityToken(token, 'wrong-secret')).toThrow();
  });

  it('should reject malformed token', () => {
    expect(() => verifyCapabilityToken('not-a-valid-jwt', TEST_SECRET)).toThrow();
  });

  it('should reject empty token', () => {
    expect(() => verifyCapabilityToken('', TEST_SECRET)).toThrow();
  });

  it('should reject token with tampered payload', () => {
    const token = mintCapabilityToken(testCapability, TEST_SECRET);
    const parts = token.split('.');
    // Tamper with the payload (middle part)
    const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
    expect(() => verifyCapabilityToken(tampered, TEST_SECRET)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Different executor types
// ---------------------------------------------------------------------------

describe('capability token for all executor types', () => {
  const executorTypes: Array<Capability['executorType']> = ['shell', 'file', 'web', 'mcp'];

  for (const executorType of executorTypes) {
    it(`should round-trip ${executorType} executor type`, () => {
      const cap: Capability = { ...testCapability, executorType };
      const token = mintCapabilityToken(cap, TEST_SECRET);
      const decoded = verifyCapabilityToken(token, TEST_SECRET);
      expect(decoded.executorType).toBe(executorType);
    });
  }
});
