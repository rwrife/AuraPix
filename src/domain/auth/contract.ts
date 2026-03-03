import type { OAuthSignInInput, Session, SignInInput, SignUpInput, User } from './types';

export interface AuthService {
  signIn(input: SignInInput): Promise<Session>;
  signInWithOAuth(input: OAuthSignInInput): Promise<Session>;
  signUp(input: SignUpInput): Promise<Session>;
  signOut(): Promise<void>;
  getCurrentUser(): Promise<User | null>;
  getSession(): Promise<Session | null>;
}
