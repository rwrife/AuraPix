import { render, screen } from '@testing-library/react';
import { App } from './App';

describe('App', () => {
  it('renders project heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'AuraPix' })).toBeInTheDocument();
  });
});
