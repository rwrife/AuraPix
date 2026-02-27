/**
 * Library domain model with ownership tracking
 */

export interface Library {
  id: string;
  userId: string;         // Owner user ID
  createdAt: string;
  updatedAt: string;
}

/**
 * Create a new library document
 */
export function createLibrary(id: string, userId: string): Library {
  const now = new Date().toISOString();
  return {
    id,
    userId,
    createdAt: now,
    updatedAt: now,
  };
}