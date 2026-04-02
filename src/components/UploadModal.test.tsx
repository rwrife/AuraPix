import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UploadModal } from './UploadModal';

vi.mock('../features/albums/useAlbums', () => ({
  useAlbums: () => ({
    albums: [],
    createAlbum: vi.fn(),
  }),
}));

describe('UploadModal', () => {
  it('shows ignored unsupported files while keeping supported files selected', async () => {
    render(<UploadModal onClose={vi.fn()} onUpload={vi.fn()} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const supported = new File(['img'], 'photo.jpg', { type: 'image/jpeg' });
    const unsupported = new File(['notes'], 'notes.txt', { type: 'text/plain' });

    fireEvent.change(fileInput, {
      target: {
        files: [supported, unsupported],
      },
    });

    expect(await screen.findByText('Unsupported file ignored: notes.txt', { exact: false })).toBeInTheDocument();
    expect(await screen.findByText('1 file selected')).toBeInTheDocument();
  });

  it('allows dismissing the unsupported file warning', async () => {
    const user = userEvent.setup();
    render(<UploadModal onClose={vi.fn()} onUpload={vi.fn()} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: {
        files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })],
      },
    });

    expect(await screen.findByRole('status')).toHaveTextContent('Unsupported file ignored: notes.txt');
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
