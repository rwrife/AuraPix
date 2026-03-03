import { useState } from 'react';
import { useTeams, type TeamRole } from '../features/teams/useTeams';

const ROLE_OPTIONS: TeamRole[] = ['owner', 'admin', 'editor', 'contributor', 'viewer'];

export function TeamsPage() {
  const { workspace, roleCounts, lastRoleChangeError, updateRole, inviteMember } = useTeams();
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

      <div className="teams-panel">
        <h2>Members</h2>
        <ul className="teams-member-list">
          {workspace.members.map((member) => (
            <li key={member.id} className="teams-member-row">
              <div className="teams-member-meta">
                <div className="teams-member-name">{member.name}</div>
                <div className="teams-member-email">
                  {member.email}
                  {member.invited ? ' · invited' : ''}
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
          ))}
        </ul>
      </div>

      <form className="teams-panel teams-invite-form" onSubmit={handleInviteSubmit}>
        <h2>Invite member</h2>
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
