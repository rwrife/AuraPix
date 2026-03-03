import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTeams } from './useTeams';

describe('useTeams invitation lifecycle', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  it('creates pending invite then accepts into members', () => {
    const { result } = renderHook(() => useTeams());

    act(() => {
      result.current.inviteMember('Casey', 'casey@example.com', 'viewer');
    });

    expect(result.current.pendingInvitations).toHaveLength(1);
    expect(result.current.workspace.members.some((member) => member.email === 'casey@example.com')).toBe(false);

    const inviteId = result.current.pendingInvitations[0].id;

    act(() => {
      result.current.acceptInvitation(inviteId);
    });

    expect(result.current.pendingInvitations).toHaveLength(0);
    expect(result.current.workspace.members.some((member) => member.email === 'casey@example.com')).toBe(true);
  });

  it('declines invitation without adding member', () => {
    const { result } = renderHook(() => useTeams());

    act(() => {
      result.current.inviteMember('Jamie', 'jamie@example.com', 'contributor');
    });

    const inviteId = result.current.pendingInvitations[0].id;

    act(() => {
      result.current.declineInvitation(inviteId);
    });

    expect(result.current.pendingInvitations).toHaveLength(0);
    expect(result.current.workspace.members.some((member) => member.email === 'jamie@example.com')).toBe(false);
  });
});
