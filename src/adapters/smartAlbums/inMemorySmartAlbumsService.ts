import type {
  MaterializeResult,
  SmartAlbumsService,
} from '../../domain/smartAlbums/contract';
import type {
  CreateSmartAlbumInput,
  SmartAlbum,
  SmartAlbumFilter,
  UpdateSmartAlbumInput,
} from '../../domain/smartAlbums/types';

const PER_LIBRARY_CAP = 200;

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ALLOWED_KEYS = new Set([
  'rating',
  'flag',
  'tags',
  'capturedBetween',
  'mimeTypes',
]);

/**
 * Mirror of the backend's filter validator. Strict — unknown keys throw.
 * Kept intentionally small so the local adapter stays consistent with the
 * server (errors at this layer behave the same as a 400 from the API).
 */
function validateFilter(input: unknown): SmartAlbumFilter {
  if (!isPlainObject(input)) {
    throw new Error('Filter must be an object.');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Filter contains unknown key "${key}".`);
    }
  }
  const out: SmartAlbumFilter = {};
  if (input.rating !== undefined) {
    if (!isPlainObject(input.rating)) throw new Error('rating must be an object.');
    const { gte, lte } = input.rating as { gte?: unknown; lte?: unknown };
    if (gte !== undefined && (typeof gte !== 'number' || gte < 0 || gte > 5)) {
      throw new Error('rating.gte must be 0..5.');
    }
    if (lte !== undefined && (typeof lte !== 'number' || lte < 0 || lte > 5)) {
      throw new Error('rating.lte must be 0..5.');
    }
    if (
      typeof gte === 'number' &&
      typeof lte === 'number' &&
      gte > lte
    ) {
      throw new Error('rating.gte cannot exceed rating.lte.');
    }
    out.rating = {
      ...(typeof gte === 'number' ? { gte } : {}),
      ...(typeof lte === 'number' ? { lte } : {}),
    };
  }
  if (input.flag !== undefined) {
    if (input.flag !== 'pick' && input.flag !== 'reject') {
      throw new Error('flag must be "pick" or "reject".');
    }
    out.flag = input.flag;
  }
  if (input.tags !== undefined) {
    if (
      !Array.isArray(input.tags) ||
      input.tags.some((t) => typeof t !== 'string' || !t.trim())
    ) {
      throw new Error('tags must be a non-empty string array.');
    }
    out.tags = (input.tags as string[]).map((t) => t.trim());
  }
  if (input.capturedBetween !== undefined) {
    if (!Array.isArray(input.capturedBetween) || input.capturedBetween.length !== 2) {
      throw new Error('capturedBetween must be a [from, to] tuple.');
    }
    out.capturedBetween = input.capturedBetween as [string, string];
  }
  if (input.mimeTypes !== undefined) {
    if (
      !Array.isArray(input.mimeTypes) ||
      input.mimeTypes.some((m) => typeof m !== 'string' || !m.trim())
    ) {
      throw new Error('mimeTypes must be a non-empty string array.');
    }
    out.mimeTypes = (input.mimeTypes as string[]).map((m) => m.trim());
  }
  return out;
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Smart album name is required.');
  if (trimmed.length > 120) throw new Error('Smart album name is too long.');
  return trimmed;
}

export class InMemorySmartAlbumsService implements SmartAlbumsService {
  private albums: SmartAlbum[] = [];

  async listByLibrary(libraryId: string): Promise<SmartAlbum[]> {
    return this.albums
      .filter((a) => a.libraryId === libraryId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<SmartAlbum | null> {
    return this.albums.find((a) => a.id === id) ?? null;
  }

  async create(input: CreateSmartAlbumInput): Promise<SmartAlbum> {
    const filter = validateFilter(input.filter);
    const name = normalizeName(input.name);
    const count = this.albums.filter((a) => a.libraryId === input.libraryId).length;
    if (count >= PER_LIBRARY_CAP) {
      throw new Error(`Smart album cap of ${PER_LIBRARY_CAP} reached for this library.`);
    }
    const now = new Date().toISOString();
    const record: SmartAlbum = {
      id: uid('smart-album'),
      tenantId: 'local',
      libraryId: input.libraryId,
      ownerId: 'local-user-1',
      name,
      filter,
      createdAt: now,
      updatedAt: now,
    };
    this.albums = [record, ...this.albums];
    return record;
  }

  async update(id: string, updates: UpdateSmartAlbumInput): Promise<SmartAlbum> {
    const idx = this.albums.findIndex((a) => a.id === id);
    if (idx < 0) throw new Error(`Smart album ${id} not found.`);
    const next: SmartAlbum = { ...this.albums[idx] };
    if (updates.name !== undefined) next.name = normalizeName(updates.name);
    if (updates.filter !== undefined) next.filter = validateFilter(updates.filter);
    next.updatedAt = new Date().toISOString();
    this.albums = [...this.albums.slice(0, idx), next, ...this.albums.slice(idx + 1)];
    return next;
  }

  async remove(id: string): Promise<void> {
    this.albums = this.albums.filter((a) => a.id !== id);
  }

  async materialize(): Promise<MaterializeResult> {
    // The local in-memory adapter does not have access to the photo store
    // here; the React feature uses the existing photo grid. This stub is
    // intentionally empty so unit tests can spy on it. Real materialization
    // happens against the backend in `firebase` mode (or via the local
    // backend when both are running).
    return { photos: [], nextPageToken: null, total: 0 };
  }
}
