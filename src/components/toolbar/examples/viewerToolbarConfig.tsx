import type { Photo } from '../../../domain/library/types';
import type { ToolbarButton, ModalContentProps } from '../types';

interface ViewerToolbarConfigProps {
  currentPhoto: Photo;
  onToggleFavorite: () => void;
  onDelete: () => void;
  brightness: number;
  setBrightness: (v: number) => void;
  contrast: number;
  setContrast: (v: number) => void;
  saturation: number;
  setSaturation: (v: number) => void;
}

/**
 * Example configuration for viewer toolbar
 * Demonstrates all three button types: toggle, modal, and panel
 */
export function createViewerToolbarConfig({
  currentPhoto,
  onToggleFavorite,
  onDelete,
  brightness,
  setBrightness,
  contrast,
  setContrast,
  saturation,
  setSaturation,
}: ViewerToolbarConfigProps): ToolbarButton[] {
  return [
    // Modal button example: Delete with confirmation
    {
      type: 'modal',
      id: 'delete',
      icon: '🗑',
      title: 'Delete',
      className: 'btn-danger-ghost',
      modalTitle: 'Delete photo?',
      modalContent: ({ onClose }: ModalContentProps) => (
        <>
          <p className="state-message">This will permanently delete this photo.</p>
          <div className="confirm-modal-actions">
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-danger-ghost"
              onClick={() => {
                onDelete();
                onClose();
              }}
            >
              Delete
            </button>
          </div>
        </>
      ),
    },

    // Panel button example: Info
    {
      type: 'panel',
      id: 'info',
      icon: 'ℹ',
      title: 'Info',
      panelContent: (
        <>
          <p className="state-message">Name: {currentPhoto.originalName}</p>
          <p className="state-message">ID: {currentPhoto.id}</p>
        </>
      ),
    },

    // Panel button example: Versions
    {
      type: 'panel',
      id: 'versions',
      icon: '⧉',
      title: 'Versions',
      panelContent: <p className="state-message">Version history tools coming soon.</p>,
    },

    // Toggle button example: Favorite
    {
      type: 'toggle',
      id: 'favorite',
      icon: '♥',
      title: currentPhoto.isFavorite ? 'Unfavorite' : 'Favorite',
      isActive: currentPhoto.isFavorite,
      onClick: onToggleFavorite,
    },

    // Panel button example: Comments
    {
      type: 'panel',
      id: 'comments',
      icon: '💬',
      title: 'Comments',
      panelContent: <p className="state-message">Comments tools coming soon.</p>,
    },

    // Panel button example: Tags
    {
      type: 'panel',
      id: 'tags',
      icon: '#',
      title: 'Tags',
      panelContent: <p className="state-message">Tag management tools coming soon.</p>,
    },

    // Panel button example: Presets
    {
      type: 'panel',
      id: 'presets',
      icon: '✶',
      title: 'Presets',
      panelContent: <p className="state-message">Preset tools coming soon.</p>,
    },

    // Panel button example: Edit with interactive controls
    {
      type: 'panel',
      id: 'edit',
      icon: '🎚',
      title: 'Edit',
      panelContent: (
        <>
          <label className="settings-label" htmlFor="edit-brightness">
            Brightness
          </label>
          <input
            id="edit-brightness"
            type="range"
            min={-100}
            max={100}
            value={brightness}
            onChange={(e) => setBrightness(Number(e.target.value))}
          />
          <label className="settings-label" htmlFor="edit-contrast">
            Contrast
          </label>
          <input
            id="edit-contrast"
            type="range"
            min={-100}
            max={100}
            value={contrast}
            onChange={(e) => setContrast(Number(e.target.value))}
          />
          <label className="settings-label" htmlFor="edit-saturation">
            Saturation
          </label>
          <input
            id="edit-saturation"
            type="range"
            min={-100}
            max={100}
            value={saturation}
            onChange={(e) => setSaturation(Number(e.target.value))}
          />
        </>
      ),
    },

    // Panel button example: Crop
    {
      type: 'panel',
      id: 'crop',
      icon: '⬚',
      title: 'Crop',
      panelContent: <p className="state-message">Crop tools coming soon.</p>,
    },
  ];
}
