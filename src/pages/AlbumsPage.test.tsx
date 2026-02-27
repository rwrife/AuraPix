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
});
