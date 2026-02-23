import { fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';

describe('App', () => {
  it('renders project heading', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'AuraPix' })).toBeInTheDocument();
    expect(await screen.findByText('Sample Highlights')).toBeInTheDocument();
  });

  it('creates a new album from form input', async () => {
    render(<App />);

    const input = screen.getByLabelText('Album name');
    fireEvent.change(input, { target: { value: 'Weekend Trip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create album' }));

    expect(await screen.findByText('Weekend Trip')).toBeInTheDocument();
  });

  it('shows validation error when album name is empty', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Create album' }));

    expect(await screen.findByText('Album name is required.')).toBeInTheDocument();
  });
});
