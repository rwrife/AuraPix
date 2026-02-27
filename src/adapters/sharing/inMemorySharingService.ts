import type { SharingService } from '../../domain/sharing/contract';
import type {
  CreateShareLinkInput,
  ResolveShareDownloadInput,
  ResolveShareLinkInput,
  UpdateShareLinkPolicyInput,
  ShareAccessEvent,
  ShareDownloadResolution,
  ShareLink,
} from '../../domain/sharing/types';

// ---------------------------------------------------------------------------
// In-memory sharing service.
// In local/single-user mode sharing links are stored in memory only —
// they are not persisted because there is no other user to share with.
// ---------------------------------------------------------------------------

export class InMemorySharingService implements SharingService {
  private links: ShareLink[] = [];
  private linkPasswords = new Map<string, string>();
  private events: ShareAccessEvent[] = [];

  async createShareLink(input: CreateShareLinkInput): Promise<ShareLink> {
    const now = new Date().toISOString();
    const token = `local-share-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const permission = input.policy.permission ?? 'view';
    const link: ShareLink = {
      id: `link-${Date.now()}`,
      token,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      policy: {
        permission,
        expiresAt: input.policy.expiresAt ?? null,
        passwordProtected: !!input.password,
        maxUses: input.policy.maxUses ?? null,
        downloadPolicy:
          input.policy.downloadPolicy ??
          (permission === 'download' ? 'original_and_derivative' : 'none'),
        watermarkEnabled: input.policy.watermarkEnabled ?? false,
      },
      useCount: 0,
      revoked: false,
      createdAt: now,
      createdBy: 'local-user-1',
    };

    if (input.password) {
      this.linkPasswords.set(link.id, input.password);
    }

    this.links = [link, ...this.links];
    return link;
  }

  async listShareLinks(resourceId: string): Promise<ShareLink[]> {
    return this.links.filter((l) => l.resourceId === resourceId && !l.revoked);
  }

  async listAccessEvents(resourceId: string): Promise<ShareAccessEvent[]> {
    const linkIds = new Set(this.links.filter((l) => l.resourceId === resourceId).map((l) => l.id));

    return this.events.filter((event) => (event.linkId ? linkIds.has(event.linkId) : false));
  }

  async revokeShareLink(linkId: string): Promise<void> {
    this.links = this.links.map((l) => (l.id === linkId ? { ...l, revoked: true } : l));
  }

  async updateShareLinkPolicy(input: UpdateShareLinkPolicyInput): Promise<ShareLink> {
    const link = this.links.find((l) => l.id === input.linkId);
    if (!link) {
      throw new Error('Share link not found.');
    }

    const permission = input.policy.permission ?? link.policy.permission;
    const nextDownloadPolicy =
      input.policy.downloadPolicy ??
      (permission === 'download'
        ? link.policy.downloadPolicy === 'none'
          ? 'original_and_derivative'
          : link.policy.downloadPolicy
        : 'none');

    const nextPolicy = {
      ...link.policy,
      ...input.policy,
      permission,
      downloadPolicy: nextDownloadPolicy,
      watermarkEnabled:
        nextDownloadPolicy === 'none'
          ? false
          : input.policy.watermarkEnabled ?? link.policy.watermarkEnabled,
    };

    const updated = { ...link, policy: nextPolicy };
    this.links = this.links.map((l) => (l.id === link.id ? updated : l));
    return updated;
  }

  async resolveShareLink(input: ResolveShareLinkInput): Promise<ShareLink | null> {
    const link = this.validateAccess(input, 'link_resolve');
    if (!link) {
      return null;
    }

    return this.markGranted(link, input.token, 'granted', 'link_resolve');
  }

  async resolveShareDownload(
    input: ResolveShareDownloadInput
  ): Promise<ShareDownloadResolution | null> {
    const attempt = input.assetKind === 'original' ? 'download_original' : 'download_derivative';
    const link = this.validateAccess(input, attempt);
    if (!link) {
      return null;
    }

    if (link.policy.downloadPolicy === 'none') {
      this.recordEvent({
        token: input.token,
        link,
        attempt,
        outcome: 'denied_download_disallowed',
      });
      return null;
    }

    if (link.policy.downloadPolicy === 'derivative_only' && input.assetKind === 'original') {
      this.recordEvent({
        token: input.token,
        link,
        attempt,
        outcome: 'denied_download_disallowed',
      });
      return null;
    }

    const resolved = this.markGranted(link, input.token, 'granted_download', attempt);

    return {
      link: resolved,
      assetKind: input.assetKind,
      watermarkApplied: input.assetKind === 'derivative' && resolved.policy.watermarkEnabled,
    };
  }

  private validateAccess(input: ResolveShareLinkInput, attempt: ShareAccessEvent['attempt']): ShareLink | null {
    const link = this.links.find((l) => l.token === input.token);
    if (!link) {
      this.recordEvent({ token: input.token, attempt, link: null, outcome: 'denied_not_found' });
      return null;
    }

    if (link.revoked) {
      this.recordEvent({ token: input.token, attempt, link, outcome: 'denied_revoked' });
      return null;
    }

    if (link.policy.expiresAt && new Date(link.policy.expiresAt) < new Date()) {
      this.recordEvent({ token: input.token, attempt, link, outcome: 'denied_expired' });
      return null;
    }

    if (link.policy.maxUses !== null && link.useCount >= link.policy.maxUses) {
      this.recordEvent({ token: input.token, attempt, link, outcome: 'denied_max_uses' });
      return null;
    }

    if (link.policy.passwordProtected) {
      const expected = this.linkPasswords.get(link.id);
      if (!expected || input.password !== expected) {
        this.recordEvent({
          token: input.token,
          attempt,
          link,
          outcome: 'denied_invalid_password',
        });
        return null;
      }
    }

    return link;
  }

  private markGranted(
    link: ShareLink,
    token: string,
    outcome: Extract<ShareAccessEvent['outcome'], 'granted' | 'granted_download'>,
    attempt: ShareAccessEvent['attempt']
  ): ShareLink {
    const resolved = { ...link, useCount: link.useCount + 1 };

    // Increment use count
    this.links = this.links.map((l) => (l.id === link.id ? resolved : l));
    this.recordEvent({ token, attempt, link: resolved, outcome });

    return resolved;
  }

  private recordEvent(input: {
    token: string;
    link: ShareLink | null;
    attempt: ShareAccessEvent['attempt'];
    outcome: ShareAccessEvent['outcome'];
  }): void {
    this.events = [
      {
        id: `share-event-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        token: input.token,
        linkId: input.link?.id ?? null,
        resourceType: input.link?.resourceType ?? null,
        resourceId: input.link?.resourceId ?? null,
        attempt: input.attempt,
        outcome: input.outcome,
        occurredAt: new Date().toISOString(),
      },
      ...this.events,
    ];
  }
}
