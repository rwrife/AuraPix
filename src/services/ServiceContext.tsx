import { createContext, type ReactNode } from 'react';
import type { AlbumsService } from '../domain/albums/contract';
import type { AuthService } from '../domain/auth/contract';
import type { LibraryService } from '../domain/library/contract';
import type { SharingService } from '../domain/sharing/contract';
import type { UploadSessionsService } from '../domain/uploads/contract';

// ---------------------------------------------------------------------------
// ServiceContext — dependency injection for all backend abstractions.
// UI components consume services through useServices() — see useServices.ts.
// ---------------------------------------------------------------------------

export interface Services {
  auth: AuthService;
  albums: AlbumsService;
  library: LibraryService;
  sharing: SharingService;
  uploads: UploadSessionsService;
}

// eslint-disable-next-line react-refresh/only-export-components
export const ServiceContext = createContext<Services | null>(null);

export function ServiceProvider({
  services,
  children,
}: {
  services: Services;
  children: ReactNode;
}) {
  return <ServiceContext.Provider value={services}>{children}</ServiceContext.Provider>;
}
