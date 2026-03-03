import { describe, expect, it } from 'vitest';
import { canRolePerform, roleCapabilitySummary } from './permissions';

describe('team permissions matrix', () => {
  it('enforces expected upload/edit/share/delete permissions by role', () => {
    expect(roleCapabilitySummary('viewer')).toEqual({
      upload: false,
      edit: false,
      share: false,
      delete: false,
    });

    expect(roleCapabilitySummary('contributor')).toEqual({
      upload: true,
      edit: false,
      share: false,
      delete: false,
    });

    expect(roleCapabilitySummary('editor')).toEqual({
      upload: true,
      edit: true,
      share: false,
      delete: false,
    });

    expect(roleCapabilitySummary('admin')).toEqual({
      upload: true,
      edit: true,
      share: true,
      delete: true,
    });

    expect(roleCapabilitySummary('owner')).toEqual({
      upload: true,
      edit: true,
      share: true,
      delete: true,
    });
  });

  it('exposes action checks for UI/API guardrails', () => {
    expect(canRolePerform('editor', 'edit')).toBe(true);
    expect(canRolePerform('editor', 'share')).toBe(false);
    expect(canRolePerform('contributor', 'upload')).toBe(true);
    expect(canRolePerform('viewer', 'upload')).toBe(false);
  });
});
