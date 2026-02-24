import type { SharingService } from "../../domain/sharing/contract";
import type {
  CreateShareLinkInput,
  ResolveShareLinkInput,
  ShareLink,
} from "../../domain/sharing/types";

// ---------------------------------------------------------------------------
// In-memory sharing service.
// In local/single-user mode sharing links are stored in memory only —
// they are not persisted because there is no other user to share with.
// ---------------------------------------------------------------------------

export class InMemorySharingService implements SharingService {
  private links: ShareLink[] = [];

  async createShareLink(input: CreateShareLinkInput): Promise<ShareLink> {
    const now = new Date().toISOString();
    const token = `local-share-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const link: ShareLink = {
      id: `link-${Date.now()}`,
      token,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      policy: {
        permission: input.policy.permission ?? "view",
        expiresAt: input.policy.expiresAt ?? null,
        passwordProtected: !!input.password,
        maxUses: input.policy.maxUses ?? null,
      },
      useCount: 0,
      revoked: false,
      createdAt: now,
      createdBy: "local-user-1",
    };

    this.links = [link, ...this.links];
    return link;
  }

  async listShareLinks(resourceId: string): Promise<ShareLink[]> {
    return this.links.filter(
      (l) => l.resourceId === resourceId && !l.revoked,
    );
  }

  async revokeShareLink(linkId: string): Promise<void> {
    this.links = this.links.map((l) =>
      l.id === linkId ? { ...l, revoked: true } : l,
    );
  }

  async resolveShareLink(
    input: ResolveShareLinkInput,
  ): Promise<ShareLink | null> {
    const link = this.links.find((l) => l.token === input.token);
    if (!link || link.revoked) return null;

    if (
      link.policy.expiresAt &&
      new Date(link.policy.expiresAt) < new Date()
    ) {
      return null;
    }

    if (link.policy.maxUses !== null && link.useCount >= link.policy.maxUses) {
      return null;
    }

    // Increment use count
    this.links = this.links.map((l) =>
      l.id === link.id ? { ...l, useCount: l.useCount + 1 } : l,
    );

    return { ...link, useCount: link.useCount + 1 };
  }
}