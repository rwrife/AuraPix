import type { AuthService } from '../../domain/auth/contract';
import type { Session, SignInInput, SignUpInput, User } from '../../domain/auth/types';

// ---------------------------------------------------------------------------
// Single-user in-memory auth service.
// In local mode, there's a single implicit "local user" that requires no auth.
// The user is always considered "signed in" for local single-user mode.
// ---------------------------------------------------------------------------

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
  /** In local mode, we always have a single implicit user */
  private session: Session = makeSession(LOCAL_USER);

  constructor() {
    // In local mode, user is always authenticated as the local user
    // No need to persist or restore from localStorage
  }

  async signIn(_input: SignInInput): Promise<Session> {
    // In local mode, sign-in is a no-op - always returns the local user session
    return this.session;
  }

  async signUp(_input: SignUpInput): Promise<Session> {
    // In local mode, sign-up is a no-op - always returns the local user session
    return this.session;
  }

  async signOut(): Promise<void> {
    // In local mode, sign-out is a no-op - user remains authenticated
    // This is a stub for when Firebase auth is connected
  }

  async getCurrentUser(): Promise<User> {
    // In local mode, always return the local user
    return this.session.user;
  }

  async getSession(): Promise<Session> {
    // In local mode, always return the local user session
    return this.session;
  }
}
