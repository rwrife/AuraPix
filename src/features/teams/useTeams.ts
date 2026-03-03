import { useCallback, useEffect, useMemo, useState } from 'react';
import { canTransitionRole } from './roleSafeguards';

export type TeamRole = 'owner' | 'admin' | 'editor' | 'contributor' | 'viewer';
export type TeamInvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  invited: boolean;
}

export interface TeamInvitation {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  status: TeamInvitationStatus;
  invitedAt: string;
  expiresAt: string;
  decidedAt?: string;
}

export interface TeamWorkspace {
  id: string;
  name: string;
  members: TeamMember[];
  invitations: TeamInvitation[];
}

const STORAGE_KEY = 'aurapix.local.teams.v1';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_WORKSPACE: TeamWorkspace = {
  id: 'team-local-1',
  name: 'Studio Team',
  members: [
    {
      id: 'member-1',
      name: 'You',
      email: 'you@local.aurapix',
      role: 'owner',
      invited: false,
    },
    {
      id: 'member-2',
      name: 'Assistant Editor',
      email: 'assistant@local.aurapix',
      role: 'editor',
      invited: false,
    },
  ],
  invitations: [],
};

function normalizeWorkspace(value: unknown): TeamWorkspace {
  if (!value || typeof value !== 'object') return DEFAULT_WORKSPACE;

  const parsed = value as Partial<TeamWorkspace>;
  if (!parsed.id || !Array.isArray(parsed.members)) {
    return DEFAULT_WORKSPACE;
  }

  return {
    id: parsed.id,
    name: typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : DEFAULT_WORKSPACE.name,
    members: parsed.members,
    invitations: Array.isArray(parsed.invitations) ? parsed.invitations : [],
  };
}

function expireStaleInvitations(workspace: TeamWorkspace, nowMs = Date.now()): TeamWorkspace {
  let updated = false;

  const invitations = workspace.invitations.map((invitation) => {
    if (invitation.status !== 'pending') return invitation;

    const expiresAtMs = Date.parse(invitation.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) {
      return invitation;
    }

    updated = true;
    return {
      ...invitation,
      status: 'expired' as const,
      decidedAt: new Date(nowMs).toISOString(),
    };
  });

  if (!updated) return workspace;
  return { ...workspace, invitations };
}

function readStoredWorkspace(): TeamWorkspace {
  if (typeof window === 'undefined') return DEFAULT_WORKSPACE;

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_WORKSPACE;

  try {
    const parsed = JSON.parse(raw);
    return expireStaleInvitations(normalizeWorkspace(parsed));
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

export function useTeams() {
  const [workspace, setWorkspace] = useState<TeamWorkspace>(() => readStoredWorkspace());
  const [lastRoleChangeError, setLastRoleChangeError] = useState<string | null>(null);
  const [lastInviteError, setLastInviteError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const next = expireStaleInvitations(workspace);

    if (next !== workspace) {
      setWorkspace(next);
      return;
    }

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  }, [workspace]);

  const updateRole = useCallback((memberId: string, role: TeamRole) => {
    let updated = false;

    setWorkspace((prev) => {
      const transition = canTransitionRole(prev, memberId, role);
      if (!transition.ok) {
        setLastRoleChangeError(transition.reason ?? 'Role change blocked by workspace policy.');
        return prev;
      }

      updated = true;
      return {
        ...prev,
        members: prev.members.map((member) => (member.id === memberId ? { ...member, role } : member)),
      };
    });

    if (updated) {
      setLastRoleChangeError(null);
    }
  }, []);

  const inviteMember = useCallback((name: string, email: string, role: TeamRole) => {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const normalizedEmail = email.trim().toLowerCase();

    let blockedByDuplicateMember = false;

    setWorkspace((prev) => {
      const memberExists = prev.members.some((member) => member.email.trim().toLowerCase() === normalizedEmail);
      if (memberExists) {
        blockedByDuplicateMember = true;
        return prev;
      }

      const existingPendingInvite = prev.invitations.find(
        (invitation) => invitation.status === 'pending' && invitation.email.trim().toLowerCase() === normalizedEmail
      );

      if (existingPendingInvite) {
        return {
          ...prev,
          invitations: [
            {
              ...existingPendingInvite,
              name,
              email: normalizedEmail,
              role,
              invitedAt: nowIso,
              expiresAt: new Date(nowMs + INVITE_TTL_MS).toISOString(),
              status: 'pending',
              decidedAt: undefined,
            },
            ...prev.invitations.filter((invitation) => invitation.id !== existingPendingInvite.id),
          ],
        };
      }

      return {
        ...prev,
        invitations: [
          {
            id: `invite-${nowMs}`,
            name,
            email: normalizedEmail,
            role,
            status: 'pending',
            invitedAt: nowIso,
            expiresAt: new Date(nowMs + INVITE_TTL_MS).toISOString(),
          },
          ...prev.invitations,
        ],
      };
    });

    if (blockedByDuplicateMember) {
      setLastInviteError('Member is already in this workspace.');
      return;
    }

    setLastInviteError(null);
    setLastRoleChangeError(null);
  }, []);

  const acceptInvitation = useCallback((invitationId: string) => {
    setLastInviteError(null);
    setWorkspace((prev) => {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();

      const invitation = prev.invitations.find((item) => item.id === invitationId);
      if (!invitation || invitation.status !== 'pending') {
        return prev;
      }

      if (Date.parse(invitation.expiresAt) <= nowMs) {
        return {
          ...prev,
          invitations: prev.invitations.map((item) =>
            item.id === invitationId ? { ...item, status: 'expired', decidedAt: nowIso } : item
          ),
        };
      }

      const alreadyMember = prev.members.some(
        (member) => member.email.trim().toLowerCase() === invitation.email.trim().toLowerCase()
      );

      return {
        ...prev,
        members: alreadyMember
          ? prev.members
          : [
              ...prev.members,
              {
                id: `member-${nowMs}`,
                name: invitation.name,
                email: invitation.email,
                role: invitation.role,
                invited: false,
              },
            ],
        invitations: prev.invitations.map((item) =>
          item.id === invitationId ? { ...item, status: 'accepted', decidedAt: nowIso } : item
        ),
      };
    });
  }, []);

  const declineInvitation = useCallback((invitationId: string) => {
    setLastInviteError(null);
    setWorkspace((prev) => {
      const nowIso = new Date().toISOString();
      return {
        ...prev,
        invitations: prev.invitations.map((item) =>
          item.id === invitationId && item.status === 'pending'
            ? { ...item, status: 'declined', decidedAt: nowIso }
            : item
        ),
      };
    });
  }, []);

  const roleCounts = useMemo(() => {
    return workspace.members.reduce<Record<TeamRole, number>>(
      (acc, member) => {
        acc[member.role] += 1;
        return acc;
      },
      {
        owner: 0,
        admin: 0,
        editor: 0,
        contributor: 0,
        viewer: 0,
      }
    );
  }, [workspace.members]);

  const pendingInvitations = useMemo(
    () => workspace.invitations.filter((invitation) => invitation.status === 'pending'),
    [workspace.invitations]
  );

  return {
    workspace,
    roleCounts,
    pendingInvitations,
    lastRoleChangeError,
    lastInviteError,
    updateRole,
    inviteMember,
    acceptInvitation,
    declineInvitation,
  };
}
