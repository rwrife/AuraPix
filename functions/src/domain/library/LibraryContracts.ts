export interface LibraryMembership {
  libraryId: string;
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface LibraryAccessPolicy {
  getMembership(libraryId: string, userId: string): Promise<LibraryMembership | null>;
}
