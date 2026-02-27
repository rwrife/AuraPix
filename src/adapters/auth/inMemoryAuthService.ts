import type { AuthService } from '../../domain/auth/contract';
import type { Session, SignInInput, SignUpInput, User } from '../../domain/auth/types';

// ---------------------------------------------------------------------------
// Single-user in-memory auth service.
// In local mode there is no real authentication — a default user is
// auto-created and persisted in localStorage so sessions survive refresh.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'aurapix:local:session';
const MAX_FAILED_SIGN_IN_ATTEMPTS = 5;
const SIGN_IN_LOCKOUT_WINDOW_MS = 10 * 60 * 1000;

interface SignInAttemptState {
  failedAttempts: number;
  lockoutUntilMs: number | null;
}

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
  private signInAttempts = new Map<string, SignInAttemptState>();

  private getAttemptState(email: string, nowMs: number): SignInAttemptState {
    const attempt = this.signInAttempts.get(email);
    if (!attempt) {
      return { failedAttempts: 0, lockoutUntilMs: null };
    }

    if (attempt.lockoutUntilMs && nowMs >= attempt.lockoutUntilMs) {
      this.signInAttempts.delete(email);
      return { failedAttempts: 0, lockoutUntilMs: null };
    }

    return attempt;
  }

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
    const nowMs = Date.now();
    const attemptState = this.getAttemptState(input.email, nowMs);

    if (attemptState.lockoutUntilMs && nowMs < attemptState.lockoutUntilMs) {
      const secondsRemaining = Math.ceil((attemptState.lockoutUntilMs - nowMs) / 1000);
      throw new Error(`Too many failed sign-in attempts. Try again in ${secondsRemaining}s.`);
    }

    const entry = this.users.get(input.email);
    if (!entry || entry.password !== input.password) {
      const nextFailedAttempts = attemptState.failedAttempts + 1;
      const lockedOut = nextFailedAttempts >= MAX_FAILED_SIGN_IN_ATTEMPTS;
      this.signInAttempts.set(input.email, {
        failedAttempts: lockedOut ? 0 : nextFailedAttempts,
        lockoutUntilMs: lockedOut ? nowMs + SIGN_IN_LOCKOUT_WINDOW_MS : null,
      });
      if (lockedOut) {
        throw new Error('Too many failed sign-in attempts. Try again later.');
      }
      throw new Error('Invalid email or password.');
    }

    this.signInAttempts.delete(input.email);
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
