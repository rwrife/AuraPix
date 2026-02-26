import type { AuthService } from '../../domain/auth/contract';
import type { Session, SignInInput, SignUpInput, User } from '../../domain/auth/types';

// ---------------------------------------------------------------------------
// Single-user in-memory auth service.
// In local mode there is no real authentication — a default user is
// auto-created and persisted in localStorage so sessions survive refresh.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'aurapix:local:session';

const LOCAL_USER: User = {
  id: 'local-user-1',
  email: 'local@aurapix.local',
  displayName: 'Local User',
  photoUrl: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
};

function makeSession(user: User): Session {
  return {
    user,
    token: `local-token-${user.id}`,
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

export class InMemoryAuthService implements AuthService {
  /** In-memory user store: email → user */
  private users = new Map<string, { user: User; password: string }>([
    [LOCAL_USER.email, { user: LOCAL_USER, password: 'local' }],
  ]);

  private session: Session | null = null;

  constructor() {
    // Restore session from localStorage on construction
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        this.session = JSON.parse(raw) as Session;
      } else {
        // Auto sign-in as local user
        this.session = makeSession(LOCAL_USER);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.session));
      }
    } catch {
      this.session = makeSession(LOCAL_USER);
    }
  }

  async signIn(input: SignInInput): Promise<Session> {
    const entry = this.users.get(input.email);
    if (!entry || entry.password !== input.password) {
      throw new Error('Invalid email or password.');
    }
    this.session = makeSession(entry.user);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.session));
    return this.session;
  }

  async signUp(input: SignUpInput): Promise<Session> {
    if (this.users.has(input.email)) {
      throw new Error('An account with that email already exists.');
    }
    const user: User = {
      id: `local-user-${Date.now()}`,
      email: input.email,
      displayName: input.displayName ?? null,
      photoUrl: null,
      createdAt: new Date().toISOString(),
    };
    this.users.set(input.email, { user, password: input.password });
    this.session = makeSession(user);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.session));
    return this.session;
  }

  async signOut(): Promise<void> {
    this.session = null;
    localStorage.removeItem(STORAGE_KEY);
  }

  async getCurrentUser(): Promise<User | null> {
    return this.session?.user ?? null;
  }

  async getSession(): Promise<Session | null> {
    return this.session;
  }
}
