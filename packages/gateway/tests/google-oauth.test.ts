import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthStore, OAuthTokenData, ServiceName } from '../src/services/oauth.js';
import { GoogleOAuthService } from '../src/services/google-oauth.js';

class FakeOAuthStore {
  private tokens = new Map<ServiceName, OAuthTokenData>();

  storeToken(service: ServiceName, tokenData: OAuthTokenData): void {
    this.tokens.set(service, tokenData);
  }

  getToken(service: ServiceName): OAuthTokenData | null {
    return this.tokens.get(service) ?? null;
  }

  hasToken(service: ServiceName): boolean {
    return this.tokens.has(service);
  }

  deleteToken(service: ServiceName): boolean {
    return this.tokens.delete(service);
  }
}

describe('GoogleOAuthService', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const createService = (): {
    store: FakeOAuthStore;
    service: GoogleOAuthService;
  } => {
    const store = new FakeOAuthStore();
    const service = new GoogleOAuthService(store as unknown as OAuthStore, {
      clientId: 'test-client-id.apps.googleusercontent.com',
      clientSecret: 'test-client-secret',
      callbackPort: 0,
    });
    // Stub callback server for test environment
    (service as unknown as { ensureCallbackServer: () => Promise<void>; callbackPort: number })
      .ensureCallbackServer = async () => {
      (service as unknown as { callbackPort: number }).callbackPort = 9876;
    };
    return { store, service };
  };

  it('completes authorization-code login and stores tokens under both services', async () => {
    const { store, service } = createService();

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'google_access_token_123',
          refresh_token: 'google_refresh_token_123',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const login = await service.startLogin('user-1', 'chat-1');
    const authUrl = new URL(login.authUrl);
    const state = authUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    await service.completeFromCallbackInput(
      'user-1',
      `http://localhost:9876/auth/google/callback?code=auth_code_123&state=${state}`,
    );

    // Both gmail and calendar tokens should be stored
    expect(store.hasToken('gmail')).toBe(true);
    expect(store.hasToken('calendar')).toBe(true);

    const gmailToken = store.getToken('gmail');
    const calendarToken = store.getToken('calendar');
    expect(gmailToken?.accessToken).toBe('google_access_token_123');
    expect(gmailToken?.refreshToken).toBe('google_refresh_token_123');
    expect(gmailToken?.provider).toBe('google');
    expect(calendarToken?.accessToken).toBe('google_access_token_123');

    // isConnected should return true
    expect(service.isConnected()).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it('generates correct authorize URL with offline access and consent prompt', async () => {
    const { service } = createService();

    const login = await service.startLogin('user-1', 'chat-1');
    const authUrl = new URL(login.authUrl);

    expect(authUrl.origin).toBe('https://accounts.google.com');
    expect(authUrl.pathname).toBe('/o/oauth2/v2/auth');
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('client_id')).toBe('test-client-id.apps.googleusercontent.com');
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('prompt')).toBe('consent');
    expect(authUrl.searchParams.get('state')).toBeTruthy();

    // Verify scopes include both Gmail and Calendar
    const scope = authUrl.searchParams.get('scope') ?? '';
    expect(scope).toContain('gmail');
    expect(scope).toContain('calendar');

    await service.stop();
  });

  it('rejects callback when state belongs to a different user', async () => {
    const { service } = createService();

    const login = await service.startLogin('user-owner', 'chat-owner');
    const state = new URL(login.authUrl).searchParams.get('state');
    await expect(
      service.completeFromCallbackInput(
        'user-attacker',
        `http://localhost:9876/auth/google/callback?code=abc123&state=${state}`,
      ),
    ).rejects.toThrow('does not belong to this user');

    expect(fetchMock).not.toHaveBeenCalled();
    await service.stop();
  });

  it('rejects initial Google auth URL in manual callback mode', async () => {
    const { service } = createService();

    await service.startLogin('user-1', 'chat-1');

    await expect(
      service.completeFromCallbackInput(
        'user-1',
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=foo',
      ),
    ).rejects.toThrow('missing OAuth code/state');

    expect(fetchMock).not.toHaveBeenCalled();
    await service.stop();
  });

  it('refreshes expired token and stores under both services', async () => {
    const { store, service } = createService();

    // Store an expired token
    const expiredToken: OAuthTokenData = {
      accessToken: 'old_access_token',
      refreshToken: 'old_refresh_token',
      expiresAt: Date.now() - 10_000,
      tokenType: 'Bearer',
      provider: 'google',
    };
    store.storeToken('gmail', expiredToken);
    store.storeToken('calendar', expiredToken);

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new_access_token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const refreshed = await service.refreshTokenIfNeeded(expiredToken);
    expect(refreshed.accessToken).toBe('new_access_token');
    // Refresh token should be preserved from the original
    expect(refreshed.refreshToken).toBe('old_refresh_token');

    // Both service tokens should be updated
    const gmailToken = store.getToken('gmail');
    const calendarToken = store.getToken('calendar');
    expect(gmailToken?.accessToken).toBe('new_access_token');
    expect(calendarToken?.accessToken).toBe('new_access_token');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it('disconnect removes both gmail and calendar tokens', async () => {
    const { store, service } = createService();

    // Store tokens for both services
    const token: OAuthTokenData = {
      accessToken: 'access_123',
      refreshToken: 'refresh_123',
      expiresAt: Date.now() + 3600000,
      tokenType: 'Bearer',
      provider: 'google',
    };
    store.storeToken('gmail', token);
    store.storeToken('calendar', token);

    expect(store.hasToken('gmail')).toBe(true);
    expect(store.hasToken('calendar')).toBe(true);

    const removed = service.disconnect();
    expect(removed).toBe(true);
    expect(store.hasToken('gmail')).toBe(false);
    expect(store.hasToken('calendar')).toBe(false);
    expect(service.isConnected()).toBe(false);

    await service.stop();
  });

  it('sends client_secret in token exchange request', async () => {
    const { service } = createService();

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access_token',
          refresh_token: 'refresh_token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const login = await service.startLogin('user-1', 'chat-1');
    const state = new URL(login.authUrl).searchParams.get('state');

    await service.completeFromCallbackInput(
      'user-1',
      `http://localhost:9876/auth/google/callback?code=code123&state=${state}`,
    );

    // Verify the token exchange included client_secret
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = options.body as URLSearchParams;
    expect(body.get('client_secret')).toBe('test-client-secret');
    expect(body.get('client_id')).toBe('test-client-id.apps.googleusercontent.com');
    expect(body.get('grant_type')).toBe('authorization_code');

    await service.stop();
  });
});
