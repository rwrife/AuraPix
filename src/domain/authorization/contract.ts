/**
 * Generic authorization interface for AuraPix.
 * Projects can implement this to add quota management, permissions checks, and operation logging.
 * 
 * This is optional - if not provided, operations proceed without authorization checks.
 */

export interface UploadAuthRequest {
  userId: string;
  albumId: string | null;
  fileSizeBytes: number;
  fileName: string;
  mimeType: string;
}

export interface ShareAuthRequest {
  userId: string;
  resourceType: 'photo' | 'album';
  resourceId: string;
  shareWithUserId?: string;
  shareWithEmail?: string;
  permissionLevel: 'view' | 'edit';
}

export interface DeleteAuthRequest {
  userId: string;
  resourceType: 'photo' | 'album' | 'folder';
  resourceId: string;
  fileSizeBytes?: number;
}

export interface AuthResponse {
  authorized: boolean;
  reason?: string;
  operationId?: string;
}

export interface OperationRecord {
  operationId: string;
  userId: string;
  operationType: 'upload' | 'share' | 'delete' | 'update';
  resourceType: 'photo' | 'album' | 'folder';
  resourceId: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  success: boolean;
  errorMessage?: string;
}

/**
 * Optional operation authorizer for privileged operations.
 * Projects can provide an implementation to enforce business rules.
 */
export interface OperationAuthorizer {
  authorizeUpload?(request: UploadAuthRequest): Promise<AuthResponse>;
  authorizeShare?(request: ShareAuthRequest): Promise<AuthResponse>;
  authorizeDelete?(request: DeleteAuthRequest): Promise<AuthResponse>;
  recordOperation?(operation: OperationRecord): Promise<void>;
}