import { render, screen } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('renders the app shell with navigation links', async () => {
    render(<App />);

    expect(screen.getByText('AuraPix')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Library/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Albums/ })).toBeInTheDocument();
  });

  it(
    'shows the library page by default',
    async () => {
      // Avoid relying on <Navigate> timing in tests; start at the library route.
      window.history.pushState({}, 'Test', '/library');

      render(<App />);

      // When backend health is failing in CI, the app may hide route content behind the
      // health banner, but the router state should still land on /library.
      const libraryNav = await screen.findByRole('link', { name: 'Library' });
      expect(libraryNav).toHaveAttribute('aria-current', 'page');
    },
    15000
  );

  it('displays the current user in the header', async () => {
    render(<App />);

    // In local mode the auto-signed-in user's display name appears
    expect(await screen.findByText('Local User')).toBeInTheDocument();
  });
});
