import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  updateProfile,
  type Auth,
  type User as FirebaseUser,
} from 'firebase/auth';
import type { AuthService } from '../../domain/auth/contract';
import type { Session, SignInInput, SignUpInput, User } from '../../domain/auth/types';

/**
 * Firebase implementation of AuthService.
 * This is a generic adapter that can be used by any project using Firebase Authentication.
 */
export class FirebaseAuthService implements AuthService {
  private auth: Auth;
  private currentUser: User | null = null;
  private currentSession: Session | null = null;

  constructor(auth: Auth) {
    this.auth = auth;

    // Subscribe to auth state changes
    onAuthStateChanged(this.auth, (firebaseUser) => {
      if (firebaseUser) {
        this.currentUser = this.mapFirebaseUserToUser(firebaseUser);
        this.updateSession(firebaseUser);
      } else {
        this.currentUser = null;
        this.currentSession = null;
      }
    });
  }

  async signIn(input: SignInInput): Promise<Session> {
    const credential = await signInWithEmailAndPassword(
      this.auth,
      input.email,
      input.password
    );

    const user = this.mapFirebaseUserToUser(credential.user);
    const session = await this.createSession(credential.user);

    this.currentUser = user;
    this.currentSession = session;

    return session;
  }

  async signUp(input: SignUpInput): Promise<Session> {
    const credential = await createUserWithEmailAndPassword(
      this.auth,
      input.email,
      input.password
    );

    // Update display name if provided
    if (input.displayName) {
      await updateProfile(credential.user, {
        displayName: input.displayName,
      });
      // Reload to get updated profile
      await credential.user.reload();
    }

    const user = this.mapFirebaseUserToUser(credential.user);
    const session = await this.createSession(credential.user);

    this.currentUser = user;
    this.currentSession = session;

    return session;
  }

  async signOut(): Promise<void> {
    await firebaseSignOut(this.auth);
    this.currentUser = null;
    this.currentSession = null;
  }

  async getCurrentUser(): Promise<User | null> {
    // Return cached user if available
    if (this.currentUser) {
      return this.currentUser;
    }

    // Wait for auth state to be determined
    return new Promise((resolve) => {
      const unsubscribe = onAuthStateChanged(this.auth, (firebaseUser) => {
        unsubscribe();
        resolve(firebaseUser ? this.mapFirebaseUserToUser(firebaseUser) : null);
      });
    });
  }

  async getSession(): Promise<Session | null> {
    // Return cached session if available
    if (this.currentSession) {
      return this.currentSession;
    }

    // Wait for auth state to be determined
    return new Promise((resolve) => {
      const unsubscribe = onAuthStateChanged(this.auth, async (firebaseUser) => {
        unsubscribe();
        if (firebaseUser) {
          const session = await this.createSession(firebaseUser);
          resolve(session);
        } else {
          resolve(null);
        }
      });
    });
  }

  /**
   * Map Firebase User to AuraPix User type
   */
  private mapFirebaseUserToUser(firebaseUser: FirebaseUser): User {
    return {
      id: firebaseUser.uid,
      email: firebaseUser.email || '',
      displayName: firebaseUser.displayName,
      photoUrl: firebaseUser.photoURL,
      createdAt: firebaseUser.metadata.creationTime || new Date().toISOString(),
    };
  }

  /**
   * Create session from Firebase user
   */
  private async createSession(firebaseUser: FirebaseUser): Promise<Session> {
    const token = await firebaseUser.getIdToken();
    const tokenResult = await firebaseUser.getIdTokenResult();

    return {
      user: this.mapFirebaseUserToUser(firebaseUser),
      token,
      expiresAt: tokenResult.expirationTime,
    };
  }

  /**
   * Update cached session
   */
  private async updateSession(firebaseUser: FirebaseUser): Promise<void> {
    this.currentSession = await this.createSession(firebaseUser);
  }
}