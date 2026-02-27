import { describe, expect, it } from 'vitest';
import { canTransitionRole, countOwners, LAST_OWNER_BLOCK_MESSAGE } from './roleSafeguards';
import type { TeamWorkspace } from './useTeams';

function createWorkspace(): TeamWorkspace {
  return {
    id: 'workspace-1',
    name: 'Test Workspace',
    members: [
      { id: 'u1', name: 'Owner', email: 'owner@test.dev', role: 'owner', invited: false },
      { id: 'u2', name: 'Editor', email: 'editor@test.dev', role: 'editor', invited: false },
    ],
  };
}

describe('roleSafeguards', () => {
  it('counts owner members', () => {
    expect(countOwners(createWorkspace())).toBe(1);
  });

  it('blocks demoting the last owner', () => {
    const result = canTransitionRole(createWorkspace(), 'u1', 'admin');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(LAST_OWNER_BLOCK_MESSAGE);
  });

  it('allows owner demotion when another owner exists', () => {
    const workspace = createWorkspace();
    workspace.members.push({
      id: 'u3',
      name: 'Second Owner',
      email: 'owner2@test.dev',
      role: 'owner',
      invited: false,
    });

    const result = canTransitionRole(workspace, 'u1', 'admin');

    expect(result.ok).toBe(true);
  });
});
