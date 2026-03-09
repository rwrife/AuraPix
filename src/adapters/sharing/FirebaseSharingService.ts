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
  type QueryDocumentSnapshot,
  type DocumentData,
} from 'firebase/firestore';
import { nanoid } from 'nanoid';
import type { SharingService } from '../../domain/sharing/contract';
import { hashPassword, isVersionedPasswordHash, verifyPassword } from './passwordHash';
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

    const policy = this.normalizePolicy({
      permission: input.policy.permission ?? 'view',
      expiresAt: input.policy.expiresAt ?? null,
      passwordProtected: !!input.password,
      maxUses: input.policy.maxUses ?? null,
      downloadPolicy: input.policy.downloadPolicy,
      watermarkEnabled: input.policy.watermarkEnabled,
    });

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
      docData.passwordHash = await hashPassword(input.password);
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
    const existing = await getDocs(
      query(collection(this.db, 'shareLinks'), where('__name__', '==', linkId))
    );

    if (existing.empty) {
      return;
    }

    const linkDoc = existing.docs[0];
    const link = { id: linkDoc.id, ...linkDoc.data() } as ShareLink;
    if (link.revoked) {
      return;
    }

    const docRef = doc(this.db, 'shareLinks', linkId);
    await updateDoc(docRef, {
      revoked: true,
      revokedAt: serverTimestamp(),
    });

    await this.logAccessEvent(link.token, link.id, 'revoked', 'link_revoke', {
      ...link,
      revoked: true,
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
    const nextPolicy = this.normalizePolicy({
      ...current.policy,
      ...input.policy,
    });

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
    const validated = await this.validateAccess(input, 'link_resolve');
    if (!validated) {
      return null;
    }

    const resolved = await this.incrementUseCount(validated);
    await this.logAccessEvent(input.token, resolved.id, 'granted', 'link_resolve', resolved);
    return resolved;
  }

  async resolveShareDownload(
    input: ResolveShareDownloadInput
  ): Promise<ShareDownloadResolution | null> {
    const attempt: ShareAccessAttempt =
      input.assetKind === 'original' ? 'download_original' : 'download_derivative';

    const validated = await this.validateAccess(input, attempt);
    if (!validated) {
      return null;
    }

    const { link } = validated;

    // Check download policy
    const { downloadPolicy } = link.policy;
    if (downloadPolicy === 'none') {
      await this.logAccessEvent(input.token, link.id, 'denied_download_disallowed', attempt, link);
      return null;
    }

    if (downloadPolicy === 'derivative_only' && input.assetKind === 'original') {
      await this.logAccessEvent(input.token, link.id, 'denied_download_disallowed', attempt, link);
      return null;
    }

    const resolved = await this.incrementUseCount(validated);
    await this.logAccessEvent(input.token, resolved.id, 'granted_download', attempt, resolved);

    return {
      link: resolved,
      assetKind: input.assetKind,
      watermarkApplied:
        input.assetKind === 'derivative' && resolved.policy.watermarkEnabled,
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

  private async findLinkByToken(
    token: string
  ): Promise<{ linkDoc: QueryDocumentSnapshot<DocumentData>; link: ShareLink } | null> {
    const q = query(collection(this.db, 'shareLinks'), where('token', '==', token));
    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      return null;
    }

    const linkDoc = snapshot.docs[0];
    const link = { id: linkDoc.id, ...linkDoc.data() } as ShareLink;
    return { linkDoc, link };
  }

  private async validateAccess(
    input: ResolveShareLinkInput,
    attempt: ShareAccessAttempt
  ): Promise<{ linkDoc: QueryDocumentSnapshot<DocumentData>; link: ShareLink } | null> {
    const found = await this.findLinkByToken(input.token);
    if (!found) {
      await this.logAccessEvent(input.token, null, 'denied_not_found', attempt, null);
      return null;
    }

    const { linkDoc, link } = found;

    if (link.revoked) {
      await this.logAccessEvent(input.token, link.id, 'denied_revoked', attempt, link);
      return null;
    }

    if (link.policy.expiresAt && new Date(link.policy.expiresAt) <= new Date()) {
      await this.logAccessEvent(input.token, link.id, 'denied_expired', attempt, link);
      return null;
    }

    if (link.policy.maxUses !== null && link.useCount >= link.policy.maxUses) {
      await this.logAccessEvent(input.token, link.id, 'denied_max_uses', attempt, link);
      return null;
    }

    if (link.policy.passwordProtected) {
      if (!input.password) {
        await this.logAccessEvent(input.token, link.id, 'denied_invalid_password', attempt, link);
        return null;
      }

      const linkData = linkDoc.data() as { passwordHash?: string };
      const storedPassword = linkData.passwordHash;
      const isValidPassword =
        typeof storedPassword === 'string'
          ? isVersionedPasswordHash(storedPassword)
            ? await verifyPassword(input.password, storedPassword)
            : storedPassword === input.password
          : false;

      if (!isValidPassword) {
        await this.logAccessEvent(input.token, link.id, 'denied_invalid_password', attempt, link);
        return null;
      }
    }

    return { linkDoc, link };
  }

  private async incrementUseCount(input: {
    linkDoc: QueryDocumentSnapshot<DocumentData>;
    link: ShareLink;
  }): Promise<ShareLink> {
    const resolved = { ...input.link, useCount: input.link.useCount + 1 };

    await updateDoc(input.linkDoc.ref, {
      useCount: resolved.useCount,
      lastAccessedAt: serverTimestamp(),
    });

    return resolved;
  }

  private normalizePolicy(input: {
    permission: SharePolicy['permission'];
    expiresAt: SharePolicy['expiresAt'];
    passwordProtected: SharePolicy['passwordProtected'];
    maxUses: SharePolicy['maxUses'];
    downloadPolicy?: SharePolicy['downloadPolicy'];
    watermarkEnabled?: SharePolicy['watermarkEnabled'];
  }): SharePolicy {
    const downloadPolicy =
      input.permission === 'download'
        ? (input.downloadPolicy ?? 'original_and_derivative')
        : 'none';

    return {
      permission: input.permission,
      expiresAt: input.expiresAt,
      passwordProtected: input.passwordProtected,
      maxUses: input.maxUses,
      downloadPolicy,
      watermarkEnabled:
        downloadPolicy === 'none' ? false : (input.watermarkEnabled ?? false),
    };
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