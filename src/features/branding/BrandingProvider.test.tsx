import { describe, it, expect, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import {
  BrandingProvider,
  applyBrandingToDocument,
  DEFAULT_BRANDING,
  useBranding,
  type Branding,
} from './BrandingProvider';

function Probe() {
  const { branding } = useBranding();
  return <span data-testid="app-name">{branding.appName}</span>;
}

describe('applyBrandingToDocument', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style');
    document.title = '';
  });

  it('sets --brand-primary and --brand-accent CSS variables', () => {
    applyBrandingToDocument({
      ...DEFAULT_BRANDING,
      primaryColor: '#abcdef',
      accentColor: '#123456',
      appName: 'TenantX',
    });
    expect(document.documentElement.style.getPropertyValue('--brand-primary')).toBe('#abcdef');
    expect(document.documentElement.style.getPropertyValue('--brand-accent')).toBe('#123456');
    expect(document.title).toBe('TenantX');
  });

  it('falls back to defaults for invalid hex colors', () => {
    applyBrandingToDocument({
      ...DEFAULT_BRANDING,
      primaryColor: 'red' as unknown as string,
      accentColor: 'rgb(0,0,0)' as unknown as string,
    });
    expect(document.documentElement.style.getPropertyValue('--brand-primary')).toBe(DEFAULT_BRANDING.primaryColor);
    expect(document.documentElement.style.getPropertyValue('--brand-accent')).toBe(DEFAULT_BRANDING.accentColor);
  });
});

describe('BrandingProvider', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style');
    document.title = '';
  });

  it('applies default branding without a tenantId', () => {
    render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>
    );
    expect(document.documentElement.style.getPropertyValue('--brand-primary')).toBe(DEFAULT_BRANDING.primaryColor);
  });

  it('fetches and applies tenant branding', async () => {
    const tenantBranding: Branding = {
      tenantId: 't1',
      appName: 'AcmePhoto',
      primaryColor: '#ff0000',
      accentColor: '#00ff00',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
    const { findByTestId } = render(
      <BrandingProvider tenantId="t1" fetchBranding={async () => tenantBranding}>
        <Probe />
      </BrandingProvider>
    );
    const el = await findByTestId('app-name');
    await waitFor(() => expect(el.textContent).toBe('AcmePhoto'));
    expect(document.documentElement.style.getPropertyValue('--brand-primary')).toBe('#ff0000');
    expect(document.documentElement.style.getPropertyValue('--brand-accent')).toBe('#00ff00');
    expect(document.title).toBe('AcmePhoto');
  });

  it('keeps defaults when fetch fails', async () => {
    render(
      <BrandingProvider tenantId="t1" fetchBranding={async () => { throw new Error('nope'); }}>
        <Probe />
      </BrandingProvider>
    );
    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--brand-primary')).toBe(DEFAULT_BRANDING.primaryColor);
    });
  });
});
