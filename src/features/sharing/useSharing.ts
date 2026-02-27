import { useCallback, useEffect, useState } from 'react';
import type { ShareDownloadPolicy, ShareLink, SharePermission } from '../../domain/sharing/types';
import { useServices } from '../../services/useServices';

interface UseSharingState {
  links: ShareLink[];
  loading: boolean;
  error: string | null;
}

interface CreateShareLinkOptions {
  expiresAt?: string;
  password?: string;
  permission?: SharePermission;
  downloadPolicy?: ShareDownloadPolicy;
  watermarkEnabled?: boolean;
}

interface UseSharingReturn extends UseSharingState {
  createLink(
    resourceType: ShareLink['resourceType'],
    resourceId: string,
    options?: CreateShareLinkOptions
  ): Promise<ShareLink>;
  revokeLink(linkId: string): Promise<void>;
}

export function useSharing(resourceId: string): UseSharingReturn {
  const { sharing } = useServices();
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    sharing
      .listShareLinks(resourceId)
      .then((l) => {
        if (!cancelled) {
          setLinks(l);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load share links.');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sharing, resourceId]);

  const createLink = useCallback(
    async (
      resourceType: ShareLink['resourceType'],
      resId: string,
      options?: CreateShareLinkOptions
    ): Promise<ShareLink> => {
      const permission = options?.permission ?? 'view';
      const defaultDownloadPolicy =
        permission === 'download' ? 'original_and_derivative' : 'none';

      const link = await sharing.createShareLink({
        resourceType,
        resourceId: resId,
        policy: {
          permission,
          expiresAt: options?.expiresAt ?? null,
          downloadPolicy: options?.downloadPolicy ?? defaultDownloadPolicy,
          watermarkEnabled: options?.watermarkEnabled ?? false,
        },
        password: options?.password,
      });
      setLinks((prev) => [link, ...prev]);
      return link;
    },
    [sharing]
  );

  const revokeLink = useCallback(
    async (linkId: string) => {
      await sharing.revokeShareLink(linkId);
      setLinks((prev) => prev.filter((l) => l.id !== linkId));
    },
    [sharing]
  );

  return { links, loading, error, createLink, revokeLink };
}
