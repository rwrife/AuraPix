import { describe, expect, it } from 'vitest';
import {
  CrossTenantAccessError,
  DEFAULT_TENANT_ID,
  TENANT_HEADER,
  assertSameTenant,
  isValidTenantId,
  normalizeTenantId,
} from './Tenant.js';
import { resolveTenant, getRequestTenantId } from '../../middleware/resolveTenant.js';

describe('Tenant primitives', () => {
  it('validates tenant ids', () => {
    expect(isValidTenantId('default')).toBe(true);
    expect(isValidTenantId('acme-corp_42')).toBe(true);
    expect(isValidTenantId('')).toBe(false);
    expect(isValidTenantId('has space')).toBe(false);
    expect(isValidTenantId('a'.repeat(65))).toBe(false);
    expect(isValidTenantId(123 as unknown as string)).toBe(false);
  });

  it('normalizes from untrusted input', () => {
    expect(normalizeTenantId('  acme  ')).toBe('acme');
    expect(normalizeTenantId('bad space')).toBeNull();
    expect(normalizeTenantId(undefined)).toBeNull();
  });

  it('treats missing tenant on resource as default', () => {
    expect(() => assertSameTenant(undefined, DEFAULT_TENANT_ID)).not.toThrow();
  });

  it('throws CrossTenantAccessError when tenants differ', () => {
    expect(() => assertSameTenant('acme', 'globex')).toThrowError(CrossTenantAccessError);
    try {
      assertSameTenant('acme', 'globex');
    } catch (err) {
      expect(err).toBeInstanceOf(CrossTenantAccessError);
      expect((err as CrossTenantAccessError).status).toBe(403);
    }
  });
});

function fakeReqRes(opts: { headers?: Record<string, unknown>; user?: any } = {}) {
  const req: any = { headers: opts.headers ?? {}, user: opts.user };
  const res: any = {};
  let called = false;
  const next = () => {
    called = true;
  };
  return { req, res, next, isCalled: () => called };
}

describe('resolveTenant middleware', () => {
  it('falls back to the default tenant when nothing is provided', () => {
    const { req, res, next } = fakeReqRes();
    resolveTenant(req, res, next);
    expect(req.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(getRequestTenantId(req)).toBe(DEFAULT_TENANT_ID);
  });

  it('honors the X-AuraPix-Tenant-Id header', () => {
    const { req, res, next } = fakeReqRes({ headers: { [TENANT_HEADER]: 'acme' } });
    resolveTenant(req, res, next);
    expect(req.tenantId).toBe('acme');
  });

  it('prefers a claim-based tenant over the header', () => {
    const { req, res, next } = fakeReqRes({
      headers: { [TENANT_HEADER]: 'header-tenant' },
      user: { uid: 'u', tenantId: 'claim-tenant' },
    });
    resolveTenant(req, res, next);
    expect(req.tenantId).toBe('claim-tenant');
  });

  it('ignores invalid header values and falls back', () => {
    const { req, res, next } = fakeReqRes({ headers: { [TENANT_HEADER]: 'bad space' } });
    resolveTenant(req, res, next);
    expect(req.tenantId).toBe(DEFAULT_TENANT_ID);
  });
});
