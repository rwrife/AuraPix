import type { Session, SignInInput, SignUpInput, User } from '../../domain/auth/types';

// ---------------------------------------------------------------------------
// Auth API contracts
// Each contract describes the shape of a single logical API operation.
// The adapter/service layer maps these to concrete implementations (local,
// Firebase, REST, etc.) without the UI needing to know which one is active.
// ---------------------------------------------------------------------------

export type SignInRequest = SignInInput;
export interface SignInResponse {
  session: Session;
}

export type SignUpRequest = SignUpInput;
export interface SignUpResponse {
  session: Session;
}

export interface GetCurrentUserResponse {
  user: User | null;
}
