import { useState } from 'react';
import { roleCapabilitySummary, type TeamAction } from '../features/teams/permissions';
import { useTeams, type TeamRole } from '../features/teams/useTeams';

const ROLE_OPTIONS: TeamRole[] = ['owner', 'admin', 'editor', 'contributor', 'viewer'];
const ACTION_LABELS: Record<TeamAction, string> = {
  upload: 'Upload',
  edit: 'Edit',
  share: 'Share',
  delete: 'Delete',
};

function formatExpiration(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Expires soon';
  return `Expires ${date.toLocaleDateString()}`;
}

export function TeamsPage() {
  const {
    workspace,
    roleCounts,
    pendingInvitations,
    lastRoleChangeError,
    lastInviteError,
    updateRole,
    inviteMember,
    acceptInvitation,
    declineInvitation,
  } = useTeams();
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<TeamRole>('viewer');

  function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = inviteName.trim();
    const email = inviteEmail.trim().toLowerCase();
    if (!name || !email) return;

    inviteMember(name, email, inviteRole);
    setInviteName('');
    setInviteEmail('');
    setInviteRole('viewer');
  }

  return (
    <section className="page teams-page">
      <header className="page-header">
        <h1 className="page-title">Teams</h1>
      </header>

      <div className="teams-subtitle">
        Workspace: <strong>{workspace.name}</strong>
      </div>

      <div className="teams-role-summary">
        {ROLE_OPTIONS.map((role) => (
          <div key={role} className="teams-role-chip">
            <span className="teams-role-name">{role}</span>
            <span className="teams-role-count">{roleCounts[role]}</span>
          </div>
        ))}
      </div>

      {lastRoleChangeError ? <p className="teams-inline-error">{lastRoleChangeError}</p> : null}

      {pendingInvitations.length > 0 ? (
        <div className="teams-panel">
          <h2>Pending invitations ({pendingInvitations.length})</h2>
          <ul className="teams-member-list">
            {pendingInvitations.map((invitation) => (
              <li key={invitation.id} className="teams-member-row">
                <div className="teams-member-meta">
                  <div className="teams-member-name">{invitation.name}</div>
                  <div className="teams-member-email">
                    {invitation.email} · {invitation.role} · {formatExpiration(invitation.expiresAt)}
                  </div>
                </div>
                <div className="teams-invite-actions">
                  <button type="button" className="btn-secondary" onClick={() => declineInvitation(invitation.id)}>
                    Decline
                  </button>
                  <button type="button" className="btn-primary" onClick={() => acceptInvitation(invitation.id)}>
                    Accept
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="teams-panel">
        <h2>Members</h2>
        <ul className="teams-member-list">
          {workspace.members.map((member) => {
            const capabilities = roleCapabilitySummary(member.role);

            return (
              <li key={member.id} className="teams-member-row">
                <div className="teams-member-meta">
                  <div className="teams-member-name">{member.name}</div>
                  <div className="teams-member-email">{member.email}</div>
                  <div className="teams-member-email">
                    {(['upload', 'edit', 'share', 'delete'] as TeamAction[]).map((action) => (
                      <span key={action}>
                        {ACTION_LABELS[action]} {capabilities[action] ? '✓' : '—'}{' '}
                      </span>
                    ))}
                  </div>
                </div>
                <label className="teams-role-select-wrap">
                  <span className="sr-only">Role for {member.name}</span>
                  <select
                    value={member.role}
                    onChange={(e) => updateRole(member.id, e.target.value as TeamRole)}
                  >
                    {ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      <form className="teams-panel teams-invite-form" onSubmit={handleInviteSubmit}>
        <h2>Invite member</h2>
        {lastInviteError ? <p className="teams-inline-error">{lastInviteError}</p> : null}
        <div className="teams-invite-grid">
          <input
            type="text"
            placeholder="Name"
            value={inviteName}
            onChange={(e) => setInviteName(e.target.value)}
          />
          <input
            type="email"
            placeholder="Email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as TeamRole)}>
            {ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-primary">
            Send invite
          </button>
        </div>
      </form>
    </section>
  );
}
