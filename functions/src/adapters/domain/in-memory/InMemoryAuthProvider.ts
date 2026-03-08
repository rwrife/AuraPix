import type {
  AuthIdentity,
  AuthProvider,
} from '../../../domain/auth/AuthContracts.js';

export class InMemoryAuthProvider implements AuthProvider {
  constructor(private readonly defaultIdentity: AuthIdentity | null = null) {}

  async resolveUser(): Promise<AuthIdentity | null> {
    return this.defaultIdentity;
  }
}
