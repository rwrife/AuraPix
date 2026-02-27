import type { DataAdapter } from '../../adapters/data/DataAdapter.js';
import type { Photo } from '../../models/Photo.js';
import type { Library } from '../../models/Library.js';
import type { ImageSignature, ImageAuthResult } from '../../models/ImageAuth.js';
import { logger } from '../../utils/logger.js';

// Share link types (subset needed for authorization)
interface ShareLink {
  id: string;
  token: string;
  resourceType: 'album' | 'photo' | 'library';
  resourceId: string;
  revoked: boolean;
  policy: {
    expiresAt: string | null;
    maxUses: number | null;
  };
  useCount: number;
}

/**
 * Service for authorizing image access based on ownership or share links
 */
export class ImageAuthorizer {
  constructor(private dataAdapter: DataAdapter) {}

  /**
   * Authorize image access for a given signature and photo
   * @param signature - Parsed and validated signature
   * @param photo - Photo document to access
   * @returns Authorization result
   */
  async authorizeImageAccess(
    signature: ImageSignature,
    photo: Photo
  ): Promise<ImageAuthResult> {
    // Authorization via user ID (library ownership)
    if (signature.userId) {
      const hasAccess = await this.checkLibraryOwnership(
        photo.libraryId,
        signature.userId
      );

      if (hasAccess) {
        logger.debug(
          { userId: signature.userId, photoId: photo.id },
          'Image access authorized via library ownership'
        );
        return {
          authorized: true,
          photo,
        };
      }

      return {
        authorized: false,
        reason: 'User does not own this library',
      };
    }

    // Authorization via share token
    if (signature.shareToken) {
      const hasAccess = await this.checkShareAccess(
        signature.shareToken,
        photo
      );

      if (hasAccess) {
        logger.debug(
          { shareToken: signature.shareToken.substring(0, 8), photoId: photo.id },
          'Image access authorized via share link'
        );
        return {
          authorized: true,
          photo,
        };
      }

      return {
        authorized: false,
        reason: 'Share token does not grant access to this photo',
      };
    }

    // No authorization method provided
    return {
      authorized: false,
      reason: 'No valid authorization method in signature',
    };
  }

  /**
   * Check if user owns the library
   * @param libraryId - Library ID to check
   * @param userId - User ID to verify
   * @returns True if user owns library
   */
  async checkLibraryOwnership(
    libraryId: string,
    userId: string
  ): Promise<boolean> {
    try {
      const library = await this.dataAdapter.fetchData<Library>(
        'libraries',
        libraryId
      );

      if (!library) {
        logger.debug({ libraryId }, 'Library not found');
        return false;
      }

      return library.userId === userId;
    } catch (error) {
      logger.error({ error, libraryId, userId }, 'Error checking library ownership');
      return false;
    }
  }

  /**
   * Check if share token grants access to photo
   * @param shareToken - Share token from signature
   * @param photo - Photo to access
   * @returns True if share link grants access
   */
  async checkShareAccess(
    shareToken: string,
    photo: Photo
  ): Promise<boolean> {
    try {
      // Query share links by token
      const shareLinks = await this.dataAdapter.queryData<ShareLink>(
        'shareLinks',
        [{ field: 'token', operator: '==', value: shareToken }]
      );

      if (shareLinks.length === 0) {
        logger.debug({ shareToken: shareToken.substring(0, 8) }, 'Share link not found');
        return false;
      }

      const shareLink = shareLinks[0];
      if (!shareLink) {
        return false;
      }

      // Check if revoked
      if (shareLink.revoked) {
        logger.debug({ linkId: shareLink.id }, 'Share link is revoked');
        return false;
      }

      // Check expiration
      if (shareLink.policy.expiresAt) {
        const expiresAt = new Date(shareLink.policy.expiresAt);
        if (expiresAt <= new Date()) {
          logger.debug({ linkId: shareLink.id }, 'Share link is expired');
          return false;
        }
      }

      // Check max uses
      if (
        shareLink.policy.maxUses &&
        shareLink.useCount >= shareLink.policy.maxUses
      ) {
        logger.debug({ linkId: shareLink.id }, 'Share link exceeded max uses');
        return false;
      }

      // Check if photo is in shared resource
      const hasAccess = await this.photoInSharedResource(shareLink, photo);

      if (hasAccess) {
        // Log successful access for compliance/analytics
        await this.logShareAccess(shareLink.id, shareToken, 'granted');
      }

      return hasAccess;
    } catch (error) {
      logger.error({ error, shareToken: shareToken.substring(0, 8) }, 'Error checking share access');
      return false;
    }
  }

  /**
   * Check if photo is part of the shared resource
   * @param shareLink - Share link to check
   * @param photo - Photo to verify
   * @returns True if photo is accessible via this share link
   */
  private async photoInSharedResource(
    shareLink: ShareLink,
    photo: Photo
  ): Promise<boolean> {
    if (shareLink.resourceType === 'photo') {
      // Direct photo share
      return shareLink.resourceId === photo.id;
    }

    if (shareLink.resourceType === 'album') {
      // Album share - check if photo is in album
      return photo.albumIds.includes(shareLink.resourceId);
    }

    if (shareLink.resourceType === 'library') {
      // Library share - check if photo is in library
      return photo.libraryId === shareLink.resourceId;
    }

    return false;
  }

  /**
   * Log share access event for analytics and audit trail
   * @param linkId - Share link ID
   * @param token - Share token
   * @param outcome - Access outcome
   */
  private async logShareAccess(
    linkId: string,
    token: string,
    outcome: string
  ): Promise<void> {
    try {
      const event = {
        id: `${Date.now()}-${Math.random().toString(36).substring(7)}`,
        linkId,
        token,
        outcome,
        occurredAt: new Date().toISOString(),
      };

      await this.dataAdapter.storeData('shareAccessEvents', event.id, event);
    } catch (error) {
      // Log error but don't fail authorization
      logger.error({ error, linkId }, 'Failed to log share access event');
    }
  }
}