import type { TeamRole, TeamWorkspace } from './useTeams';

export const LAST_OWNER_BLOCK_MESSAGE =
  'Workspace must always have at least one owner. Assign another owner before changing this role.';

export function countOwners(workspace: TeamWorkspace): number {
  return workspace.members.filter((member) => member.role === 'owner').length;
}

export function canTransitionRole(
  workspace: TeamWorkspace,
  memberId: string,
  targetRole: TeamRole
): { ok: boolean; reason?: string } {
  const member = workspace.members.find((candidate) => candidate.id === memberId);
  if (!member) {
    return { ok: false, reason: 'Member not found.' };
  }

  if (member.role === targetRole) {
    return { ok: true };
  }

  if (member.role === 'owner' && targetRole !== 'owner' && countOwners(workspace) <= 1) {
    return { ok: false, reason: LAST_OWNER_BLOCK_MESSAGE };
  }

  return { ok: true };
}
