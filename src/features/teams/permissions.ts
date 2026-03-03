import type { TeamRole } from './useTeams';

export type TeamAction = 'upload' | 'edit' | 'share' | 'delete';

const ACTION_WEIGHT: Record<TeamAction, number> = {
  upload: 1,
  edit: 2,
  share: 3,
  delete: 4,
};

const ROLE_MAX_ACTION_WEIGHT: Record<TeamRole, number> = {
  viewer: 0,
  contributor: ACTION_WEIGHT.upload,
  editor: ACTION_WEIGHT.edit,
  admin: ACTION_WEIGHT.delete,
  owner: ACTION_WEIGHT.delete,
};

export function canRolePerform(role: TeamRole, action: TeamAction): boolean {
  return ROLE_MAX_ACTION_WEIGHT[role] >= ACTION_WEIGHT[action];
}

export function roleCapabilitySummary(role: TeamRole): Record<TeamAction, boolean> {
  return {
    upload: canRolePerform(role, 'upload'),
    edit: canRolePerform(role, 'edit'),
    share: canRolePerform(role, 'share'),
    delete: canRolePerform(role, 'delete'),
  };
}
