import { useCallback, useEffect, useRef, useState } from 'react';
import { useAlbums } from '../features/albums/useAlbums';
import { isSupportedUploadFile, uploadAcceptValue } from '../features/uploads/supportedUploadFiles';

interface UploadModalProps {
  /**
   * When provided, the album selector is hidden and uploads are assigned
   * directly to this album.
   */
  preselectedAlbumId?: string | null;
  onClose(): void;
  /**
   * Called with the selected files, the resolved album id, and a progress
   * callback the implementation should invoke after each file completes.
   */
  onUpload(
    files: File[],
    albumId: string | null,
    onProgress: (completed: number, total: number) => void
  ): void | Promise<void>;
}

export function UploadModal({ preselectedAlbumId, onClose, onUpload }: UploadModalProps) {
  const showAlbumSelector = preselectedAlbumId == null;
  const { albums, createAlbum } = useAlbums();

  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>('none');
  const [newAlbumName, setNewAlbumName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedCount, setUploadedCount] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const newAlbumInputRef = useRef<HTMLInputElement>(null);

  function mergeFiles(incoming: FileList | File[] | null) {
    if (!incoming) return;
    const supportedFiles = Array.from(incoming).filter((f) => isSupportedUploadFile(f));
    if (supportedFiles.length === 0) return;
    setFiles((prev) => {
      const existingKeys = new Set(prev.map((f) => `${f.name}-${f.size}`));
      return [
        ...prev,
        ...supportedFiles.filter((f) => !existingKeys.has(`${f.name}-${f.size}`)),
      ];
    });
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    mergeFiles(e.dataTransfer.files);
  }

  function handleAlbumChange(value: string) {
    setSelectedAlbumId(value);
    if (value === 'create-new') {
      // Focus the new album input on next tick
      setTimeout(() => newAlbumInputRef.current?.focus(), 0);
    }
  }

  async function handleUpload() {
    if (files.length === 0) return;
    setUploadError(null);
    setUploading(true);

    try {
      let albumId: string | null = preselectedAlbumId ?? null;

      if (showAlbumSelector) {
        if (selectedAlbumId === 'create-new') {
          const name = newAlbumName.trim();
          if (!name) {
            setUploadError('Please enter a name for the new album.');
            setUploading(false);
            return;
          }
          const created = await createAlbum(name);
          albumId = created?.id ?? null;
        } else if (selectedAlbumId !== 'none') {
          albumId = selectedAlbumId;
        }
      }

      setUploadedCount(0);
      await onUpload(files, albumId, (completed) => {
        setUploadedCount(completed);
      });
      onClose();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  }

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-dialog" role="dialog" aria-modal="true" aria-label="Upload photos">
        {/* Header */}
        <div className="modal-header">
          <h2 className="modal-title">Upload Photos</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="modal-body">
          {/* Drop zone */}
          <div
            className={`upload-dropzone${isDragging ? ' upload-dropzone--active' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
            aria-label="Drop photos here or click to browse"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={uploadAcceptValue()}
              multiple
              hidden
              onChange={(e) => mergeFiles(e.target.files)}
            />
            <span className="upload-dropzone-icon">📷</span>
            <p className="upload-dropzone-text">Drag &amp; drop photos here</p>
            <p className="upload-dropzone-subtext">or</p>
            <button
              type="button"
              className="btn-ghost btn-sm upload-browse-btn"
              onClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
            >
              Browse files
            </button>
          </div>

          {/* Selected files list */}
          {files.length > 0 && (
            <div className="upload-file-list">
              <p className="upload-file-list-label">
                {files.length} file{files.length !== 1 ? 's' : ''} selected
              </p>
              <ul className="upload-file-items">
                {files.map((f, i) => (
                  <li key={`${f.name}-${f.size}-${i}`} className="upload-file-item">
                    <span className="upload-file-name" title={f.name}>
                      {f.name}
                    </span>
                    <span className="upload-file-size">
                      {f.size < 1024 * 1024
                        ? `${(f.size / 1024).toFixed(0)} KB`
                        : `${(f.size / (1024 * 1024)).toFixed(1)} MB`}
                    </span>
                    <button
                      type="button"
                      className="upload-file-remove"
                      onClick={() => removeFile(i)}
                      title="Remove file"
                      disabled={uploading}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Album selector — only shown when not already inside an album */}
          {showAlbumSelector && (
            <div className="upload-album-section">
              <label className="upload-label" htmlFor="upload-album-select">
                Add to album
              </label>
              <select
                id="upload-album-select"
                className="upload-album-select"
                value={selectedAlbumId}
                onChange={(e) => handleAlbumChange(e.target.value)}
                disabled={uploading}
              >
                <option value="none">None (library only)</option>
                {albums.length > 0 && (
                  <optgroup label="Existing albums">
                    {albums.map((album) => (
                      <option key={album.id} value={album.id}>
                        {album.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="create-new">+ Create new album…</option>
              </select>

              {selectedAlbumId === 'create-new' && (
                <input
                  ref={newAlbumInputRef}
                  type="text"
                  className="upload-album-name-input"
                  placeholder="New album name"
                  value={newAlbumName}
                  onChange={(e) => setNewAlbumName(e.target.value)}
                  disabled={uploading}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && files.length > 0) handleUpload();
                  }}
                />
              )}
            </div>
          )}

          {/* Progress bar — shown while uploading */}
          {uploading && files.length > 0 && (
            <div className="upload-progress">
              <div className="upload-progress-header">
                <span className="upload-progress-label">Uploading…</span>
                <span className="upload-progress-count">
                  {uploadedCount} / {files.length}
                </span>
              </div>
              <div className="upload-progress-track">
                <div
                  className="upload-progress-fill"
                  style={{
                    width: `${Math.round((uploadedCount / files.length) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}

          {uploadError && <p className="error">{uploadError}</p>}
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={uploading}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleUpload}
            disabled={files.length === 0 || uploading}
          >
            {uploading ? 'Uploading…' : `Upload${files.length > 0 ? ` (${files.length})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
