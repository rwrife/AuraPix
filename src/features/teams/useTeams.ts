import { useCallback, useEffect, useMemo, useState } from 'react';

export type TeamRole = 'owner' | 'admin' | 'editor' | 'contributor' | 'viewer';

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  invited: boolean;
}

export interface TeamWorkspace {
  id: string;
  name: string;
  members: TeamMember[];
}

const STORAGE_KEY = 'aurapix.local.teams.v1';

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
};

function readStoredWorkspace(): TeamWorkspace {
  if (typeof window === 'undefined') return DEFAULT_WORKSPACE;

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_WORKSPACE;

  try {
    const parsed = JSON.parse(raw) as TeamWorkspace;
    if (!parsed || !parsed.id || !Array.isArray(parsed.members)) {
      return DEFAULT_WORKSPACE;
    }
    return parsed;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

export function useTeams() {
  const [workspace, setWorkspace] = useState<TeamWorkspace>(() => readStoredWorkspace());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  }, [workspace]);

  const updateRole = useCallback((memberId: string, role: TeamRole) => {
    setWorkspace((prev) => ({
      ...prev,
      members: prev.members.map((member) => (member.id === memberId ? { ...member, role } : member)),
    }));
  }, []);

  const inviteMember = useCallback((name: string, email: string, role: TeamRole) => {
    setWorkspace((prev) => ({
      ...prev,
      members: [
        ...prev.members,
        {
          id: `member-${Date.now()}`,
          name,
          email,
          role,
          invited: true,
        },
      ],
    }));
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

  return {
    workspace,
    roleCounts,
    updateRole,
    inviteMember,
  };
}
