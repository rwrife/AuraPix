import { useMemo } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AlbumDetailPage } from './pages/AlbumDetailPage';
import { AlbumsPage } from './pages/AlbumsPage';
import { FolderDetailPage } from './pages/FolderDetailPage';
import { LibraryPage } from './pages/LibraryPage';
import { createLocalServices } from './services/createLocalServices';
import { ServiceProvider } from './services/ServiceContext';

export default function App() {
  const services = useMemo(() => {
    const SERVICE_MODE = import.meta.env.VITE_SERVICE_MODE ?? 'local';
    if (SERVICE_MODE === 'firebase') {
      // Firebase adapter bundle — swap in once Phase 2 Firebase adapters land
      throw new Error('Firebase mode is not yet implemented. Set VITE_SERVICE_MODE=local.');
    }
    return createLocalServices();
  }, []);

  return (
    <ServiceProvider services={services}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/library" replace />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/albums" element={<AlbumsPage />} />
            <Route path="/albums/:albumId" element={<AlbumDetailPage />} />
            <Route path="/albums/folders/:folderId" element={<FolderDetailPage />} />
            {/* Catch-all: redirect unknown paths to library */}
            <Route path="*" element={<Navigate to="/library" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ServiceProvider>
  );
}
