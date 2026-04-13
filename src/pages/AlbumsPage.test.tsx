import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

describe('AlbumsPage', () => {
  it('creates an album and updates the list without page reload', async () => {
    window.history.pushState({}, '', '/albums');
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Albums' })).toBeInTheDocument();

    const albumInput = screen.getByPlaceholderText('New album name');
    await user.type(albumInput, 'Road Trip 2026');
    await user.click(screen.getByRole('button', { name: 'Create album' }));

    expect((await screen.findAllByRole('link', { name: 'Road Trip 2026' })).length).toBeGreaterThan(0);
  });

  it('shows a validation error for duplicate album names', async () => {
    window.history.pushState({}, '', '/albums');
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Albums' })).toBeInTheDocument();

    const albumInput = screen.getByPlaceholderText('New album name');
    await user.type(albumInput, 'Sample Highlights');
    await user.click(screen.getByRole('button', { name: 'Create album' }));

    expect(await screen.findByText('An album with this name already exists.')).toBeInTheDocument();
  });

  it('supports selecting a folder during album creation', async () => {
    window.history.pushState({}, '', '/albums');
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Albums' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New Folder' }));
    await user.type(screen.getByPlaceholderText('Folder name'), 'Trips');
    await user.click(screen.getByRole('button', { name: 'Create folder' }));

    await user.type(screen.getByPlaceholderText('New album name'), 'Weekend Getaway');
    await user.selectOptions(
      screen.getByLabelText('Album folder'),
      screen.getAllByRole('option', { name: 'Trips' })[0]
    );
    await user.click(screen.getByRole('button', { name: 'Create album' }));

    const tripsSection = await screen.findByRole('link', { name: 'Trips' });
    expect(tripsSection).toBeInTheDocument();
    expect((await screen.findAllByRole('link', { name: 'Weekend Getaway' })).length).toBeGreaterThan(0);
  });



  it('filters and sorts albums from the list controls', async () => {
    window.history.pushState({}, '', '/albums');
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Albums' })).toBeInTheDocument();

    const albumInput = screen.getByPlaceholderText('New album name');

    await user.type(albumInput, 'Zoo Trip');
    await user.click(screen.getByRole('button', { name: 'Create album' }));

    await user.type(albumInput, 'Alpha Trip');
    await user.click(screen.getByRole('button', { name: 'Create album' }));

    await user.selectOptions(screen.getByLabelText('Sort albums'), 'name-asc');

    const albumLinkNames = Array.from(document.querySelectorAll('a.album-link')).map((el) =>
      el.textContent?.trim()
    );
    expect(albumLinkNames.indexOf('Alpha Trip')).toBeGreaterThanOrEqual(0);
    expect(albumLinkNames.indexOf('Zoo Trip')).toBeGreaterThanOrEqual(0);
    expect(albumLinkNames.indexOf('Alpha Trip')).toBeLessThan(albumLinkNames.indexOf('Zoo Trip'));

    await user.type(screen.getByLabelText('Search albums'), 'zoo');

    const filteredAlbumLinks = Array.from(document.querySelectorAll('a.album-link')).map((el) =>
      el.textContent?.trim()
    );
    expect(filteredAlbumLinks).toContain('Zoo Trip');
    expect(filteredAlbumLinks).not.toContain('Alpha Trip');
  });

  it('keeps album search, sort, and pagination state in the URL', async () => {
    window.history.pushState({}, '', '/albums?q=zoo&sort=name-asc');
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Albums' })).toBeInTheDocument();
    expect(screen.getByLabelText('Search albums')).toHaveValue('zoo');
    expect(screen.getByLabelText('Sort albums')).toHaveValue('name-asc');

    await user.clear(screen.getByLabelText('Search albums'));
    await user.type(screen.getByLabelText('Search albums'), 'alpha');
    expect(window.location.search).toContain('q=alpha');
    expect(window.location.search).toContain('sort=name-asc');

    await user.clear(screen.getByLabelText('Search albums'));
    expect(window.location.search).not.toContain('q=');

    for (let i = 0; i < 13; i += 1) {
      await user.clear(screen.getByPlaceholderText('New album name'));
      await user.type(screen.getByPlaceholderText('New album name'), `Paged Album ${i + 1}`);
      await user.click(screen.getByRole('button', { name: 'Create album' }));
    }

    expect(await screen.findByRole('button', { name: 'Next' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(window.location.search).toContain('page=2');
  });

  it('renames an album from the list actions', async () => {
    window.history.pushState({}, '', '/albums');
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Renamed Highlights');

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Albums' })).toBeInTheDocument();

    const renameButtons = await screen.findAllByRole('button', { name: 'Rename' });
    await user.click(renameButtons[0]);

    expect((await screen.findAllByRole('link', { name: 'Renamed Highlights' })).length).toBeGreaterThan(0);

    promptSpy.mockRestore();
  });
});
