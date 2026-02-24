/**
 * Google OAuth broker — single consent flow for Gmail + Calendar.
 *
 * Security goals:
 * - State parameter for CSRF protection.
 * - Loopback callback URL (localhost); container bind host adapts for Docker.
 * - Strict binding of pending login attempts to the initiating user/chat.
 * - Refresh-token rotation support with encrypted at-rest persistence.
 * - Tokens stored under both 'gmail' and 'calendar' service names.
 * - No credential logging.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { OAuthStore, OAuthTokenData } from './oauth.js';
import type { OAuthServiceConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFAULT_CALLBACK_PORT = 9876;
const DEFAULT_TIMEOUT_SECONDS = 600;
const TOKEN_REFRESH_BUFFER_MS = 90 * 1000;

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingLogin {
  state: string;
  userId: string;
  chatId: string;
  redirectUri: string;
  expiresAt: number;
  inProgress: boolean;
  timeout: NodeJS.Timeout;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
}

export interface GoogleConnectStartResult {
  authUrl: string;
  redirectUri: string;
  expiresInSeconds: number;
}

// ---------------------------------------------------------------------------
// Google OAuth Service
// ---------------------------------------------------------------------------

export class GoogleOAuthService {
  private oauthStore: OAuthStore;
  private config: OAuthServiceConfig;
  private pendingByState: Map<string, PendingLogin> = new Map();
  private stateByUser: Map<string, string> = new Map();
  private refreshPromise: Promise<OAuthTokenData> | null = null;
  private callbackServer: http.Server | null = null;
  private callbackPort: number | null = null;
  private callbackPublicHost: string =
    process.env['OAUTH_CALLBACK_HOST'] || 'localhost';
  private callbackBindHost: string =
    process.env['OAUTH_CALLBACK_BIND_HOST'] ||
    (isRunningInContainer() ? '0.0.0.0' : '127.0.0.1');
  private onAsyncStatus?: (chatId: string, message: string) => void;

  constructor(
    oauthStore: OAuthStore,
    config: OAuthServiceConfig,
    onAsyncStatus?: (chatId: string, message: string) => void,
  ) {
    this.oauthStore = oauthStore;
    this.config = config;
    this.onAsyncStatus = onAsyncStatus;
  }

  /**
   * Check if Google services are connected (have stored tokens).
   */
  isConnected(): boolean {
    return this.oauthStore.hasToken('gmail');
  }

  /**
   * Start a Google OAuth login flow.
   * Returns an authorization URL for the user to visit.
   */
  async startLogin(
    userId: string,
    chatId: string,
  ): Promise<GoogleConnectStartResult> {
    this.pruneExpiredLogins();
    await this.ensureCallbackServer();

    // Cancel any existing pending login for this user
    const existingState = this.stateByUser.get(userId);
    if (existingState) {
      this.clearPendingState(existingState);
    }

    const state = randomUrlSafe(24);
    const redirectUri = `http://${this.callbackPublicHost}:${this.callbackPort}/auth/google/callback`;
    const timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
    const expiresAt = Date.now() + timeoutSeconds * 1000;

    const timeout = setTimeout(() => {
      const pending = this.pendingByState.get(state);
      if (!pending) return;
      this.clearPendingState(state);
      this.onAsyncStatus?.(
        chatId,
        '⏰ Google OAuth login expired. Run /connect google to start a new login.',
      );
    }, timeoutSeconds * 1000);
    timeout.unref();

    this.pendingByState.set(state, {
      state,
      userId,
      chatId,
      redirectUri,
      expiresAt,
      inProgress: false,
      timeout,
    });
    this.stateByUser.set(userId, state);

    const authUrl = this.buildAuthorizeUrl(redirectUri, state);
    return {
      authUrl,
      redirectUri,
      expiresInSeconds: timeoutSeconds,
    };
  }

  /**
   * Complete OAuth from a user-pasted callback URL or authorization code.
   */
  async completeFromCallbackInput(
    userId: string,
    input: string,
  ): Promise<void> {
    this.pruneExpiredLogins();
    const trimmed = input.trim();
    const parsed = parseCallbackInput(trimmed);

    if (parsed) {
      await this.completeWithCode(userId, parsed.state, parsed.code);
      return;
    }

    // Raw-code fallback: only if there's exactly one pending login for this user
    const state = this.stateByUser.get(userId);
    if (!state) {
      throw new Error(
        'No pending Google OAuth login. Run /connect google first.',
      );
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      throw new Error(
        'Callback URL is missing OAuth code/state. ' +
          'Paste the final localhost callback URL (or just the code), not the Google auth URL.',
      );
    }
    await this.completeWithCode(userId, state, trimmed);
  }

  /**
   * Disconnect Google services — removes both gmail and calendar tokens.
   */
  disconnect(): boolean {
    const gmailRemoved = this.oauthStore.deleteToken('gmail');
    const calendarRemoved = this.oauthStore.deleteToken('calendar');
    return gmailRemoved || calendarRemoved;
  }

  /**
   * Stop the callback server and clean up pending logins.
   */
  async stop(): Promise<void> {
    for (const state of [...this.pendingByState.keys()]) {
      this.clearPendingState(state);
    }
    await this.stopCallbackServer();
  }

  // -------------------------------------------------------------------------
  // Callback Server
  // -------------------------------------------------------------------------

  private async ensureCallbackServer(): Promise<void> {
    if (this.callbackServer && this.callbackPort) return;

    const requestedPort = this.config.callbackPort ?? DEFAULT_CALLBACK_PORT;
    const server = http.createServer((req, res) => {
      void this.handleCallbackRequest(req, res);
    });

    const bindToPort = (port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Failed to resolve callback server address.'));
            return;
          }
          resolve((address as AddressInfo).port);
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, this.callbackBindHost);
      });

    try {
      this.callbackPort = await bindToPort(requestedPort);
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'EADDRINUSE') {
        throw new Error('Failed to start Google OAuth callback server.');
      }
      // Fallback to ephemeral port
      this.callbackPort = await bindToPort(0);
    }

    this.callbackServer = server;
    this.callbackServer.unref();
  }

  private async stopCallbackServer(): Promise<void> {
    if (!this.callbackServer) return;

    const server = this.callbackServer;
    this.callbackServer = null;
    this.callbackPort = null;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handleCallbackRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const base = `http://${this.callbackPublicHost}:${this.callbackPort ?? DEFAULT_CALLBACK_PORT}`;
      const url = new URL(req.url ?? '/', base);

      if (url.pathname !== '/auth/google/callback') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const errorCode = url.searchParams.get('error');

      if (errorCode) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(
          'Google OAuth authorization was denied. Return to ArgusClaw and retry /connect google.',
        );
        if (state) {
          const pending = this.pendingByState.get(state);
          if (pending) {
            this.onAsyncStatus?.(
              pending.chatId,
              `⚠️ Google OAuth authorization failed: ${errorCode}. Run /connect google again.`,
            );
            this.clearPendingState(state);
          }
        }
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Missing OAuth callback parameters.');
        return;
      }

      const pending = this.pendingByState.get(state);
      if (!pending || Date.now() > pending.expiresAt) {
        if (pending) this.clearPendingState(state);
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(
          'OAuth state is invalid or expired. Start again with /connect google.',
        );
        return;
      }

      await this.completeWithCode(pending.userId, state, code);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        'ArgusClaw Google OAuth login complete. Gmail and Calendar are now connected. You can close this tab.',
      );
      this.onAsyncStatus?.(
        pending.chatId,
        '✅ Google OAuth login completed. Gmail and Calendar tools are now available.',
      );
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('OAuth callback processing failed. Retry with /connect google.');
    } finally {
      this.pruneExpiredLogins();
    }
  }

  // -------------------------------------------------------------------------
  // Token Exchange
  // -------------------------------------------------------------------------

  private async completeWithCode(
    userId: string,
    state: string,
    code: string,
  ): Promise<void> {
    const pending = this.pendingByState.get(state);
    if (!pending) {
      throw new Error('OAuth state not found. Run /connect google again.');
    }
    if (pending.userId !== userId) {
      throw new Error('OAuth state does not belong to this user.');
    }
    if (Date.now() > pending.expiresAt) {
      this.clearPendingState(state);
      throw new Error('OAuth login expired. Run /connect google again.');
    }
    if (pending.inProgress) {
      throw new Error('OAuth callback already being processed.');
    }

    pending.inProgress = true;
    try {
      const tokenData = await this.exchangeAuthorizationCode(
        code,
        pending.redirectUri,
      );
      this.storeTokenForBothServices(tokenData);
      this.clearPendingState(state);
    } catch (err) {
      pending.inProgress = false;
      throw err;
    }
  }

  private async exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
  ): Promise<OAuthTokenData> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: redirectUri,
    });

    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      throw new Error(
        `Google OAuth token exchange failed (${response.status}).`,
      );
    }

    const payload = (await response.json()) as Partial<TokenResponse>;
    return this.toTokenData(payload);
  }

  // -------------------------------------------------------------------------
  // Token Refresh
  // -------------------------------------------------------------------------

  /**
   * Refresh a Google OAuth token. Serialized to prevent concurrent refreshes.
   */
  async refreshTokenIfNeeded(tokenData: OAuthTokenData): Promise<OAuthTokenData> {
    if (!this.needsRefresh(tokenData)) {
      return tokenData;
    }
    return this.refreshTokenSerialized(tokenData);
  }

  private async refreshTokenSerialized(
    tokenData: OAuthTokenData,
  ): Promise<OAuthTokenData> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshToken(tokenData).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async refreshToken(
    tokenData: OAuthTokenData,
  ): Promise<OAuthTokenData> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenData.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        this.oauthStore.deleteToken('gmail');
        this.oauthStore.deleteToken('calendar');
      }
      throw new Error(
        `Google OAuth token refresh failed (${response.status}). Reconnect with /connect google.`,
      );
    }

    const payload = (await response.json()) as Partial<TokenResponse>;
    const refreshed = this.toTokenData(payload, tokenData);
    this.storeTokenForBothServices(refreshed);
    return refreshed;
  }

  private needsRefresh(tokenData: OAuthTokenData): boolean {
    return Date.now() >= tokenData.expiresAt - TOKEN_REFRESH_BUFFER_MS;
  }

  // -------------------------------------------------------------------------
  // Token Helpers
  // -------------------------------------------------------------------------

  private toTokenData(
    payload: Partial<TokenResponse>,
    fallback?: OAuthTokenData,
  ): OAuthTokenData {
    if (!payload.access_token) {
      throw new Error('Google OAuth token response missing access_token.');
    }

    const refreshToken = payload.refresh_token ?? fallback?.refreshToken;
    if (!refreshToken) {
      throw new Error(
        'Google OAuth token response missing refresh_token. ' +
          'Ensure prompt=consent is set to receive a refresh token.',
      );
    }

    const expiresAt = payload.expires_in
      ? Date.now() + payload.expires_in * 1000
      : Date.now() + 3600 * 1000; // default 1 hour

    return {
      accessToken: payload.access_token,
      refreshToken,
      expiresAt,
      tokenType: payload.token_type ?? fallback?.tokenType ?? 'Bearer',
      scope: payload.scope ?? fallback?.scope ?? GOOGLE_SCOPES,
      provider: 'google',
      keyVersion: fallback?.keyVersion ?? 1,
    };
  }

  /**
   * Store the token under both 'gmail' and 'calendar' service names
   * so both services report as connected.
   */
  private storeTokenForBothServices(tokenData: OAuthTokenData): void {
    this.oauthStore.storeToken('gmail', tokenData);
    this.oauthStore.storeToken('calendar', tokenData);
    console.log('[google-oauth] Token stored for Gmail and Calendar');
  }

  // -------------------------------------------------------------------------
  // URL Builder
  // -------------------------------------------------------------------------

  private buildAuthorizeUrl(redirectUri: string, state: string): string {
    const url = new URL(GOOGLE_AUTH_ENDPOINT);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', GOOGLE_SCOPES);
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    return url.toString();
  }

  // -------------------------------------------------------------------------
  // State Management
  // -------------------------------------------------------------------------

  private clearPendingState(state: string): void {
    const pending = this.pendingByState.get(state);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingByState.delete(state);

    const currentState = this.stateByUser.get(pending.userId);
    if (currentState === state) {
      this.stateByUser.delete(pending.userId);
    }

    if (this.pendingByState.size === 0) {
      void this.stopCallbackServer();
    }
  }

  private pruneExpiredLogins(): void {
    const now = Date.now();
    for (const [state, pending] of this.pendingByState) {
      if (now > pending.expiresAt) {
        this.clearPendingState(state);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomUrlSafe(numBytes: number): string {
  return crypto.randomBytes(numBytes).toString('base64url');
}

function parseCallbackInput(
  input: string,
): { code: string; state: string } | null {
  try {
    const url = new URL(input);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return null;
    return { code, state };
  } catch {
    return null;
  }
}

function isRunningInContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}
