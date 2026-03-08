import type {
  LibraryAccessPolicy,
  LibraryMembership,
} from '../../../domain/library/LibraryContracts.js';

export class InMemoryLibraryAccessPolicy implements LibraryAccessPolicy {
  constructor(private readonly memberships: LibraryMembership[] = []) {}

  async getMembership(
    libraryId: string,
    userId: string
  ): Promise<LibraryMembership | null> {
    return (
      this.memberships.find(
        membership =>
          membership.libraryId === libraryId && membership.userId === userId
      ) ?? null
    );
  }
}
