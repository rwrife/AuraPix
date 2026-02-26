import { vi } from 'vitest';
import { InMemoryAuthService } from './inMemoryAuthService';

describe('InMemoryAuthService', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('auto signs in as the local user on first construction', async () => {
    const svc = new InMemoryAuthService();
    const user = await svc.getCurrentUser();
    expect(user).not.toBeNull();
    expect(user?.email).toBe('local@aurapix.local');
    expect(user?.displayName).toBe('Local User');
  });

  it('restores the session from localStorage on re-construction', async () => {
    const svc1 = new InMemoryAuthService();
    const user1 = await svc1.getCurrentUser();

    const svc2 = new InMemoryAuthService();
    const user2 = await svc2.getCurrentUser();
    expect(user2?.id).toBe(user1?.id);
  });

  it('signs in with valid credentials', async () => {
    const svc = new InMemoryAuthService();
    const session = await svc.signIn({
      email: 'local@aurapix.local',
      password: 'local',
    });
    expect(session.user.email).toBe('local@aurapix.local');
    expect(session.token).toMatch(/^local-token-/);
  });

  it('rejects sign-in with wrong password', async () => {
    const svc = new InMemoryAuthService();
    await expect(svc.signIn({ email: 'local@aurapix.local', password: 'wrong' })).rejects.toThrow(
      'Invalid email or password.'
    );
  });

  it('locks an account temporarily after repeated failed sign-in attempts', async () => {
    const svc = new InMemoryAuthService();

    for (let i = 0; i < 4; i++) {
      await expect(svc.signIn({ email: 'local@aurapix.local', password: 'wrong' })).rejects.toThrow(
        'Invalid email or password.'
      );
    }

    await expect(svc.signIn({ email: 'local@aurapix.local', password: 'wrong' })).rejects.toThrow(
      'Too many failed sign-in attempts. Try again later.'
    );

    await expect(svc.signIn({ email: 'local@aurapix.local', password: 'local' })).rejects.toThrow(
      'Too many failed sign-in attempts.'
    );
  });

  it('allows sign-in again after lockout duration passes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-26T12:00:00.000Z'));

    const svc = new InMemoryAuthService();

    for (let i = 0; i < 5; i++) {
      await expect(svc.signIn({ email: 'local@aurapix.local', password: 'wrong' })).rejects.toThrow();
    }

    vi.advanceTimersByTime(10 * 60 * 1000 + 1000);

    await expect(
      svc.signIn({
        email: 'local@aurapix.local',
        password: 'local',
      })
    ).resolves.toMatchObject({
      user: { email: 'local@aurapix.local' },
    });
  });

  it('registers a new account via signUp', async () => {
    const svc = new InMemoryAuthService();
    const session = await svc.signUp({
      email: 'new@example.com',
      password: 'pass123',
      displayName: 'New User',
    });
    expect(session.user.email).toBe('new@example.com');
    expect(session.user.displayName).toBe('New User');
  });

  it('rejects duplicate email on signUp', async () => {
    const svc = new InMemoryAuthService();
    await svc.signUp({ email: 'dup@example.com', password: 'abc' });
    await expect(svc.signUp({ email: 'dup@example.com', password: 'xyz' })).rejects.toThrow(
      'already exists'
    );
  });

  it('clears the session on signOut', async () => {
    const svc = new InMemoryAuthService();
    await svc.signOut();
    const user = await svc.getCurrentUser();
    expect(user).toBeNull();
    expect(localStorage.getItem('aurapix:local:session')).toBeNull();
  });
});
