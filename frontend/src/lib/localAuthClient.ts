// Local authentication client to replace Supabase
interface AuthUser {
  id: string;
  email: string;
  name?: string;
  is_admin?: boolean;
  tenant_id?: string;
  app_metadata?: any;
  user_metadata?: any;
  created_at?: string;
}

interface AuthSession {
  access_token: string;
  refresh_token?: string;
  user: AuthUser;
  token_type: string;
  expires_in?: number;
  expires_at?: number;
}

interface AuthResponse {
  data: { user: AuthUser | null; session: AuthSession | null };
  user: AuthUser | null;
  session: AuthSession | null;
  error: Error | null;
}

interface SignInCredentials {
  email: string;
  password: string;
}

const SESSION_TTL_SECONDS = 86400;

class LocalAuthClient {
  private subscribers: ((event: string, session: AuthSession | null) => void)[] = [];
  private session: AuthSession | null = null;
  private storageKey = 'base360-auth-token';

  constructor() {
    this.loadSession();
  }

  private getApiUrl(): string {
    return import.meta.env.VITE_API_URL || import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';
  }

  private notifySubscribers(event: string, session: AuthSession | null) {
    console.log(`📣 [LocalAuth] Notifying ${this.subscribers.length} subscribers of event: ${event}`);
    this.subscribers.forEach((callback) => {
      try {
        callback(event, session);
      } catch (e) {
        console.error('📣 [LocalAuth] Error in subscriber callback:', e);
      }
    });
  }

  private persistToStorage(session: AuthSession | null) {
    try {
      if (session?.access_token) {
        localStorage.setItem(this.storageKey, JSON.stringify(session));
      } else {
        localStorage.removeItem(this.storageKey);
      }
    } catch (error) {
      console.warn('[LocalAuth] Failed to persist session:', error);
    }
  }

  private userFromToken(accessToken: string): AuthUser | null {
    try {
      const parts = accessToken.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      const id = payload.id || payload.sub;
      const email = payload.email;
      if (!id || !email) return null;
      return {
        id,
        email,
        name: payload.user_metadata?.name || email.split('@')[0],
        is_admin: payload.is_admin,
        tenant_id: payload.tenant_id || payload.app_metadata?.tenant_id,
        app_metadata: payload.app_metadata || {},
        user_metadata: payload.user_metadata || {},
      };
    } catch {
      return null;
    }
  }

  private normalizeSession(raw: any): AuthSession | null {
    if (!raw?.access_token) return null;

    const user = raw.user || raw.currentSession?.user || this.userFromToken(raw.access_token);
    if (!user) return null;

    const expiresAt = typeof raw.expires_at === 'number'
      ? raw.expires_at
      : Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

    return {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      token_type: raw.token_type || 'bearer',
      user,
      expires_in: raw.expires_in || SESSION_TTL_SECONDS,
      expires_at: expiresAt,
    };
  }

  private saveSession(session: AuthSession | null, event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | null) {
    this.session = session;
    this.persistToStorage(session);
    if (event) {
      this.notifySubscribers(event, session);
    }
  }

  private loadSession() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (!stored) {
        this.session = null;
        return;
      }
      const parsed = JSON.parse(stored);
      const normalized = this.normalizeSession(parsed);
      if (!normalized) {
        console.warn('[LocalAuth] Stored session missing user/token, keeping raw token if present');
        this.session = parsed?.access_token ? parsed : null;
        return;
      }
      this.session = normalized;
    } catch (error) {
      console.warn('[LocalAuth] Failed to load session from storage:', error);
      this.session = null;
    }
  }

  async signInWithPassword(credentials: SignInCredentials): Promise<AuthResponse> {
    try {
      const response = await fetch(`${this.getApiUrl()}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(credentials),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || data.error || `HTTP ${response.status}`);
      }

      if (data.error) {
        throw new Error(data.error);
      }

      const session: AuthSession = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || data.access_token,
        token_type: data.token_type || 'bearer',
        user: data.user,
        expires_in: SESSION_TTL_SECONDS,
        expires_at: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      };

      this.saveSession(session, 'SIGNED_IN');

      return {
        data: { user: data.user, session },
        user: data.user,
        session,
        error: null,
      };
    } catch (error: any) {
      console.error('[LocalAuth] Sign in failed:', error);
      return {
        data: { user: null, session: null },
        user: null,
        session: null,
        error: error,
      };
    }
  }

  async signOut(): Promise<{ error: Error | null }> {
    try {
      if (this.session?.access_token) {
        try {
          await fetch(`${this.getApiUrl()}/api/v1/auth/logout`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.session.access_token}`,
            },
          });
        } catch (logoutError) {
          console.warn('[LocalAuth] Backend logout failed (continuing):', logoutError);
        }
      }

      this.saveSession(null, 'SIGNED_OUT');

      return { error: null };
    } catch (error: any) {
      console.error('[LocalAuth] Sign out failed:', error);
      this.saveSession(null, 'SIGNED_OUT');
      return { error: error };
    }
  }

  async getSession(): Promise<{ data: { session: AuthSession | null }; error: Error | null }> {
    if (!this.session) {
      this.loadSession();
    }

    if (this.session?.access_token) {
      if (!this.session.expires_at) {
        this.session.expires_at = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      }
      if (!this.session.user) {
        this.loadSession();
      }
      return { data: { session: this.session }, error: null };
    }

    return { data: { session: null }, error: null };
  }

  async refreshSession(): Promise<{ data: { session: AuthSession | null }; error: Error | null }> {
    if (!this.session) {
      this.loadSession();
    }
    if (this.session?.access_token) {
      this.session.expires_at = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
      this.session.expires_in = SESSION_TTL_SECONDS;
      this.persistToStorage(this.session);
      return { data: { session: this.session }, error: null };
    }
    return { data: { session: this.session }, error: null };
  }

  async getUser(token?: string): Promise<{ data: { user: AuthUser | null }; user: AuthUser | null; error: Error | null }> {
    if (!this.session) {
      this.loadSession();
    }

    const tokenToUse = token || this.session?.access_token;
    const storedUser = this.session?.user || null;

    if (!tokenToUse) {
      return { data: { user: null }, user: null, error: null };
    }

    if (storedUser && (!token || token === this.session?.access_token)) {
      return { data: { user: storedUser }, user: storedUser, error: null };
    }

    try {
      const response = await fetch(`${this.getApiUrl()}/api/v1/auth/me`, {
        headers: {
          'Authorization': `Bearer ${tokenToUse}`,
        },
      });

      if (response.ok) {
        const userData = await response.json();
        if (this.session && this.session.access_token === tokenToUse) {
          this.session = { ...this.session, user: userData };
          this.persistToStorage(this.session);
        }
        return { data: { user: userData }, user: userData, error: null };
      }

      if (storedUser) {
        return { data: { user: storedUser }, user: storedUser, error: null };
      }
      return { data: { user: null }, user: null, error: null };
    } catch (error: any) {
      console.error('[LocalAuth] Get user failed:', error);
      if (storedUser) {
        return { data: { user: storedUser }, user: storedUser, error: null };
      }
      return { data: { user: null }, user: null, error: error };
    }
  }

  async setSession(session: Partial<AuthSession> & { access_token?: string }): Promise<{ data: { session: AuthSession | null }; error: Error | null }> {
    try {
      if (!this.session) {
        this.loadSession();
      }

      const mergedUser = (session as AuthSession).user || this.session?.user;
      const accessToken = session.access_token || this.session?.access_token;
      if (!accessToken || !mergedUser) {
        return { data: { session: this.session }, error: null };
      }

      const merged: AuthSession = {
        ...this.session,
        ...session,
        access_token: accessToken,
        refresh_token: session.refresh_token || this.session?.refresh_token || accessToken,
        token_type: session.token_type || this.session?.token_type || 'bearer',
        user: mergedUser,
        expires_in: session.expires_in || this.session?.expires_in || SESSION_TTL_SECONDS,
        expires_at: session.expires_at || this.session?.expires_at || Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      };

      this.session = merged;
      this.persistToStorage(merged);
      return { data: { session: merged }, error: null };
    } catch (error: any) {
      return { data: { session: this.session }, error: error };
    }
  }

  onAuthStateChange(callback: (event: string, session: AuthSession | null) => void) {
    this.subscribers.push(callback);
    callback('INITIAL_SESSION', this.session);

    return {
      data: {
        subscription: {
          unsubscribe: () => {
            this.subscribers = this.subscribers.filter(cb => cb !== callback);
          }
        }
      }
    };
  }

  get auth() {
    return {
      admin: {
        getUser: this.getUser.bind(this),
        getUserById: (id: string) => this.getUser(),
        listUsers: () => Promise.resolve([]),
      },
      signInWithPassword: this.signInWithPassword.bind(this),
      signOut: this.signOut.bind(this),
      getSession: this.getSession.bind(this),
      refreshSession: this.refreshSession.bind(this),
      getUser: this.getUser.bind(this),
      setSession: this.setSession.bind(this),
      onAuthStateChange: this.onAuthStateChange.bind(this),
    };
  }
}

export const localAuthClient = new LocalAuthClient();
export default localAuthClient;
