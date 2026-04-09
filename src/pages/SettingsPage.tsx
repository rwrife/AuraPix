export function SettingsPage() {
  const serviceMode = import.meta.env.VITE_SERVICE_MODE ?? 'local';
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';

  return (
    <section className="page settings-page">
      <header className="page-header">
        <h1 className="page-title">Settings</h1>
      </header>

      <div className="settings-panel">
        <h2>Runtime</h2>
        <p>
          Service mode: <strong>{serviceMode}</strong>
        </p>
        <p>
          API base URL: <code>{apiBaseUrl}</code>
        </p>
      </div>

      <div className="settings-panel">
        <h2>Health monitoring</h2>
        <p>The app checks backend health automatically and shows a banner when the API is unavailable.</p>
      </div>
    </section>
  );
}
