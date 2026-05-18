import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface Branding {
  tenantId: string;
  appName: string;
  primaryColor: string;
  accentColor: string;
  logoUrl?: string;
  faviconUrl?: string;
  updatedAt: string;
}

export const DEFAULT_BRANDING: Branding = {
  tenantId: 'default',
  appName: 'AuraPix',
  primaryColor: '#2563eb',
  accentColor: '#7c3aed',
  updatedAt: new Date(0).toISOString(),
};

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function safeColor(value: string | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return HEX_COLOR_RE.test(value.trim()) ? value.trim() : fallback;
}

export interface BrandingContextValue {
  branding: Branding;
  loading: boolean;
}

const BrandingContext = createContext<BrandingContextValue>({
  branding: DEFAULT_BRANDING,
  loading: false,
});

export function useBranding(): BrandingContextValue {
  return useContext(BrandingContext);
}

export interface BrandingProviderProps {
  tenantId?: string;
  /** Optional override for the fetch fn (used in tests). */
  fetchBranding?: (tenantId: string) => Promise<Branding>;
  /** Optional API base URL. Defaults to relative `/api/...`. */
  apiBaseUrl?: string;
  children: ReactNode;
}

async function defaultFetchBranding(
  tenantId: string,
  apiBaseUrl: string
): Promise<Branding> {
  const url = `${apiBaseUrl}/api/v1/tenants/${encodeURIComponent(tenantId)}/branding`;
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`branding fetch failed: ${res.status}`);
  const json = (await res.json()) as { branding?: Branding };
  if (!json.branding) throw new Error('branding fetch: missing envelope');
  return json.branding;
}

/**
 * Apply branding to the document: CSS custom properties and <title>.
 * Exported for tests.
 */
export function applyBrandingToDocument(branding: Branding): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--brand-primary', safeColor(branding.primaryColor, DEFAULT_BRANDING.primaryColor));
  root.style.setProperty('--brand-accent', safeColor(branding.accentColor, DEFAULT_BRANDING.accentColor));
  if (branding.appName) {
    document.title = branding.appName;
  }
  if (branding.faviconUrl) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = branding.faviconUrl;
  }
}

export function BrandingProvider({
  tenantId,
  fetchBranding,
  apiBaseUrl = '',
  children,
}: BrandingProviderProps): JSX.Element {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [loading, setLoading] = useState<boolean>(Boolean(tenantId));

  useEffect(() => {
    // Always inject defaults synchronously so the UI never paints unbranded.
    applyBrandingToDocument(branding);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!tenantId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const fetcher = fetchBranding ?? ((id: string) => defaultFetchBranding(id, apiBaseUrl));
    fetcher(tenantId)
      .then((result) => {
        if (cancelled) return;
        const sanitized: Branding = {
          ...result,
          primaryColor: safeColor(result.primaryColor, DEFAULT_BRANDING.primaryColor),
          accentColor: safeColor(result.accentColor, DEFAULT_BRANDING.accentColor),
          appName: result.appName || DEFAULT_BRANDING.appName,
        };
        setBranding(sanitized);
        applyBrandingToDocument(sanitized);
      })
      .catch(() => {
        // Defaults already applied; nothing else to do.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, fetchBranding, apiBaseUrl]);

  return (
    <BrandingContext.Provider value={{ branding, loading }}>
      {children}
    </BrandingContext.Provider>
  );
}
