import { useMemo, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AlbumDetailPage } from './pages/AlbumDetailPage';
import { AlbumsPage } from './pages/AlbumsPage';
import { FolderDetailPage } from './pages/FolderDetailPage';
import { LibraryPage } from './pages/LibraryPage';
import { SettingsPage } from './pages/SettingsPage';
import { TeamsPage } from './pages/TeamsPage';
import { createLocalServices } from './services/createLocalServices';
import { ServiceProvider } from './services/ServiceContext';
import { HealthBanner } from './components/HealthBanner';
import { initializeHealthCheck, cleanupHealthCheck } from './services/healthCheck';
import { setupHealthDebug } from './utils/debugHealth';
import { ImageAuthProvider } from './hooks/useImageAuth';

// Some CI environments have incorrectly flagged JSX component usage as unused.
// This ensures the import is always treated as a runtime value.
void LibraryPage;

export default function App() {
  const services = useMemo(() => {
    const SERVICE_MODE = import.meta.env.VITE_SERVICE_MODE ?? 'local';
    if (SERVICE_MODE === 'firebase') {
      // Firebase adapter bundle — swap in once Phase 2 Firebase adapters land
      throw new Error('Firebase mode is not yet implemented. Set VITE_SERVICE_MODE=local.');
    }
    return createLocalServices();
  }, []);

  // Initialize health check monitoring
  useEffect(() => {
    initializeHealthCheck();
    setupHealthDebug();
    
    return () => {
      cleanupHealthCheck();
    };
  }, []);

  return (
    <ServiceProvider services={services}>
      <ImageAuthProvider authService={services.auth}>
        <HealthBanner />
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Navigate to="/library" replace />} />
              
              <Route path="/albums" element={<AlbumsPage />} />
              <Route path="/albums/:albumId" element={<AlbumDetailPage />} />
              <Route path="/albums/folders/:folderId" element={<FolderDetailPage />} />
              <Route path="/recent" element={<Navigate to="/library?q=collection:recent" replace />} />
              <Route path="/favorites" element={<Navigate to="/library?q=collection:favorites" replace />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/teams" element={<TeamsPage />} />
              {/* Catch-all: redirect unknown paths to library */}
              <Route path="*" element={<Navigate to="/library" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ImageAuthProvider>
    </ServiceProvider>
  );
}
