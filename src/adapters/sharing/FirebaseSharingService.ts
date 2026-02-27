import {
  collection,
  doc,
  getDocs,
  query,
  where,
  addDoc,
  updateDoc,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';
import { nanoid } from 'nanoid';
import type { SharingService } from '../../domain/sharing/contract';
import type {
  CreateShareLinkInput,
  ResolveShareDownloadInput,
  ResolveShareLinkInput,
  UpdateShareLinkPolicyInput,
  ShareAccessAttempt,
  ShareAccessEvent,
  ShareAccessOutcome,
  ShareDownloadResolution,
  ShareLink,
  SharePolicy,
} from '../../domain/sharing/types';

/**
 * Firebase implementation of SharingService using Firestore
 */
export class FirebaseSharingService implements SharingService {
  constructor(private db: Firestore) {}

  async createShareLink(input: CreateShareLinkInput): Promise<ShareLink> {
    const token = nanoid(32); // Generate unique token
    const now = new Date().toISOString();

    // Build complete policy with defaults
    const policy: SharePolicy = {
      permission: input.policy.permission || 'view',
      expiresAt: input.policy.expiresAt || null,
      passwordProtected: !!input.password,
      maxUses: input.policy.maxUses || null,
      downloadPolicy: input.policy.downloadPolicy || 'derivative_only',
      watermarkEnabled: input.policy.watermarkEnabled ?? false,
    };

    const shareLink: Omit<ShareLink, 'id'> = {
      token,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      policy,
      useCount: 0,
      revoked: false,
      createdAt: now,
      createdBy: 'current-user', // TODO: Get from context
    };

    // Store password hash if provided
    const docData: Omit<ShareLink, 'id'> & { passwordHash?: string } = {
      ...shareLink,
    };
    if (input.password) {
      // In production, hash the password before storing
      docData.passwordHash = input.password; // TODO: Use bcrypt or similar
    }

    const docRef = await addDoc(collection(this.db, 'shareLinks'), docData);

    return {
      id: docRef.id,
      ...shareLink,
    };
  }

  async listShareLinks(resourceId: string): Promise<ShareLink[]> {
    const q = query(
      collection(this.db, 'shareLinks'),
      where('resourceId', '==', resourceId),
      where('revoked', '==', false)
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as ShareLink[];
  }

  async revokeShareLink(linkId: string): Promise<void> {
    const docRef = doc(this.db, 'shareLinks', linkId);
    await updateDoc(docRef, {
      revoked: true,
      revokedAt: serverTimestamp(),
    });
  }

  async updateShareLinkPolicy(
    input: UpdateShareLinkPolicyInput
  ): Promise<ShareLink> {
    const docRef = doc(this.db, 'shareLinks', input.linkId);
    const existing = await getDocs(
      query(collection(this.db, 'shareLinks'), where('__name__', '==', input.linkId))
    );

    if (existing.empty) {
      throw new Error('Share link not found');
    }

    const linkDoc = existing.docs[0];
    const current = { id: linkDoc.id, ...linkDoc.data() } as ShareLink;
    const nextPolicy: SharePolicy = {
      ...current.policy,
      ...input.policy,
    };

    await updateDoc(docRef, {
      policy: nextPolicy,
      updatedAt: serverTimestamp(),
    });

    return {
      ...current,
      policy: nextPolicy,
    };
  }

  async resolveShareLink(
    input: ResolveShareLinkInput
  ): Promise<ShareLink | null> {
    const q = query(
      collection(this.db, 'shareLinks'),
      where('token', '==', input.token)
    );

    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      await this.logAccessEvent(input.token, null, 'denied_not_found', 'link_resolve', null);
      return null;
    }

    const linkDoc = snapshot.docs[0];
    const link = { id: linkDoc.id, ...linkDoc.data() } as ShareLink;

    // Check if revoked
    if (link.revoked) {
      await this.logAccessEvent(input.token, link.id, 'denied_revoked', 'link_resolve', link);
      return null;
    }

    // Check if expired
    if (link.policy.expiresAt) {
      const expiresAt = new Date(link.policy.expiresAt);
      if (expiresAt <= new Date()) {
        await this.logAccessEvent(input.token, link.id, 'denied_expired', 'link_resolve', link);
        return null;
      }
    }

    // Check max uses
    if (link.policy.maxUses && link.useCount >= link.policy.maxUses) {
      await this.logAccessEvent(input.token, link.id, 'denied_max_uses', 'link_resolve', link);
      return null;
    }

    // Check password if required
    if (link.policy.passwordProtected) {
      if (!input.password) {
        await this.logAccessEvent(input.token, link.id, 'denied_invalid_password', 'link_resolve', link);
        return null;
      }

      // Verify password (in production, compare hashes)
      const linkData = linkDoc.data() as { passwordHash?: string };
      if (linkData.passwordHash !== input.password) {
        await this.logAccessEvent(input.token, link.id, 'denied_invalid_password', 'link_resolve', link);
        return null;
      }
    }

    // Increment use count
    await updateDoc(linkDoc.ref, {
      useCount: link.useCount + 1,
      lastAccessedAt: serverTimestamp(),
    });

    await this.logAccessEvent(input.token, link.id, 'granted', 'link_resolve', link);

    return link;
  }

  async resolveShareDownload(
    input: ResolveShareDownloadInput
  ): Promise<ShareDownloadResolution | null> {
    const link = await this.resolveShareLink(input);
    if (!link) {
      return null;
    }

    // Check download policy
    const { downloadPolicy } = link.policy;
    if (downloadPolicy === 'none') {
      await this.logAccessEvent(
        input.token,
        link.id,
        'denied_download_disallowed',
        input.assetKind === 'original' ? 'download_original' : 'download_derivative',
        link
      );
      return null;
    }

    if (
      downloadPolicy === 'derivative_only' &&
      input.assetKind === 'original'
    ) {
      await this.logAccessEvent(
        input.token,
        link.id,
        'denied_download_disallowed',
        input.assetKind === 'original' ? 'download_original' : 'download_derivative',
        link
      );
      return null;
    }

    await this.logAccessEvent(input.token, link.id, 'granted_download', input.assetKind === 'original' ? 'download_original' : 'download_derivative', link);

    return {
      link,
      assetKind: input.assetKind,
      watermarkApplied: link.policy.watermarkEnabled,
    };
  }

  async listAccessEvents(resourceId: string): Promise<ShareAccessEvent[]> {
    // First get all share links for this resource
    const linksQuery = query(
      collection(this.db, 'shareLinks'),
      where('resourceId', '==', resourceId)
    );
    const linksSnapshot = await getDocs(linksQuery);
    const linkIds = linksSnapshot.docs.map((doc) => doc.id);

    if (linkIds.length === 0) {
      return [];
    }

    // Get access events for these links
    // Note: Firestore 'in' queries support up to 10 items
    // For more, we'd need to batch or use a different approach
    const eventsQuery = query(
      collection(this.db, 'shareAccessEvents'),
      where('linkId', 'in', linkIds.slice(0, 10))
    );

    const eventsSnapshot = await getDocs(eventsQuery);
    return eventsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as ShareAccessEvent[];
  }

  /**
   * Log an access event for analytics and security monitoring
   */
  private async logAccessEvent(
    token: string,
    linkId: string | null,
    outcome: ShareAccessOutcome,
    attempt: ShareAccessAttempt,
    link: ShareLink | null
  ): Promise<void> {
    const event: Omit<ShareAccessEvent, 'id'> = {
      linkId,
      token,
      resourceType: link?.resourceType ?? null,
      resourceId: link?.resourceId ?? null,
      attempt,
      outcome,
      occurredAt: new Date().toISOString(),
    };

    await addDoc(collection(this.db, 'shareAccessEvents'), event);
  }
}