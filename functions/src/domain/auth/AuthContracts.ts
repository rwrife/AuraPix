export interface AuthIdentity {
  userId: string;
  email?: string;
}

export interface AuthProvider {
  resolveUser(authHeader?: string): Promise<AuthIdentity | null>;
}
