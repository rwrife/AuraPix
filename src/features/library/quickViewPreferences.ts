import type { GridMode } from '../../components/photoGalleryConfig';

export type LibraryQuickCollectionSelection = 'all' | 'favorites' | 'tagged' | 'untagged' | 'recent';

export interface LibraryQuickViewPreferences {
  quickCollection: LibraryQuickCollectionSelection;
  activeTagFilter: string;
  cameraMakeFilter: string;
  gridMode: GridMode;
}

export interface LibrarySavedQuickViewPreset {
  id: string;
  name: string;
  preferences: LibraryQuickViewPreferences;
  createdAt: string;
}

const STORAGE_KEY_PREFIX = 'aurapix.library.quick-view';
const PRESET_STORAGE_KEY_PREFIX = 'aurapix.library.quick-view-presets';

const DEFAULT_PREFERENCES: LibraryQuickViewPreferences = {
  quickCollection: 'all',
  activeTagFilter: '',
  cameraMakeFilter: '',
  gridMode: 'medium',
};

function toStorageKey(libraryId: string) {
  return `${STORAGE_KEY_PREFIX}.${libraryId}`;
}

function toPresetStorageKey(libraryId: string) {
  return `${PRESET_STORAGE_KEY_PREFIX}.${libraryId}`;
}

function normalizeQuickCollection(value: unknown): LibraryQuickCollectionSelection {
  if (
    value === 'all' ||
    value === 'favorites' ||
    value === 'tagged' ||
    value === 'untagged' ||
    value === 'recent'
  ) {
    return value;
  }

  return DEFAULT_PREFERENCES.quickCollection;
}

function normalizeGridMode(value: unknown): GridMode {
  if (value === 'small' || value === 'medium' || value === 'large') {
    return value;
  }

  return DEFAULT_PREFERENCES.gridMode;
}

export function loadQuickViewPreferences(libraryId: string): LibraryQuickViewPreferences {
  if (typeof window === 'undefined') {
    return DEFAULT_PREFERENCES;
  }

  const raw = window.localStorage.getItem(toStorageKey(libraryId));
  if (!raw) {
    return DEFAULT_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<LibraryQuickViewPreferences>;
    return {
      quickCollection: normalizeQuickCollection(parsed.quickCollection),
      activeTagFilter: typeof parsed.activeTagFilter === 'string' ? parsed.activeTagFilter : '',
      cameraMakeFilter: typeof parsed.cameraMakeFilter === 'string' ? parsed.cameraMakeFilter : '',
      gridMode: normalizeGridMode(parsed.gridMode),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function saveQuickViewPreferences(
  libraryId: string,
  preferences: LibraryQuickViewPreferences
): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(toStorageKey(libraryId), JSON.stringify(preferences));
}

export function loadSavedQuickViewPresets(libraryId: string): LibrarySavedQuickViewPreset[] {
  if (typeof window === 'undefined') {
    return [];
  }

  const raw = window.localStorage.getItem(toPresetStorageKey(libraryId));
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as Partial<LibrarySavedQuickViewPreset>[];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((preset) => typeof preset?.name === 'string' && preset.name.trim().length > 0)
      .map((preset) => ({
        id: typeof preset.id === 'string' && preset.id ? preset.id : crypto.randomUUID(),
        name: preset.name!.trim(),
        createdAt: typeof preset.createdAt === 'string' ? preset.createdAt : new Date().toISOString(),
        preferences: {
          quickCollection: normalizeQuickCollection(preset.preferences?.quickCollection),
          activeTagFilter:
            typeof preset.preferences?.activeTagFilter === 'string'
              ? preset.preferences.activeTagFilter
              : '',
          cameraMakeFilter:
            typeof preset.preferences?.cameraMakeFilter === 'string'
              ? preset.preferences.cameraMakeFilter
              : '',
          gridMode: normalizeGridMode(preset.preferences?.gridMode),
        },
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function saveQuickViewPreset(
  libraryId: string,
  name: string,
  preferences: LibraryQuickViewPreferences
): LibrarySavedQuickViewPreset[] {
  if (typeof window === 'undefined') {
    return [];
  }

  const trimmedName = name.trim();
  if (!trimmedName) {
    return loadSavedQuickViewPresets(libraryId);
  }

  const existing = loadSavedQuickViewPresets(libraryId);
  const withoutSameName = existing.filter(
    (preset) => preset.name.toLowerCase() !== trimmedName.toLowerCase()
  );
  const nextPreset: LibrarySavedQuickViewPreset = {
    id: crypto.randomUUID(),
    name: trimmedName,
    createdAt: new Date().toISOString(),
    preferences,
  };

  const next = [...withoutSameName, nextPreset].sort((a, b) => a.name.localeCompare(b.name));
  window.localStorage.setItem(toPresetStorageKey(libraryId), JSON.stringify(next));
  return next;
}

export function deleteQuickViewPreset(
  libraryId: string,
  presetId: string
): LibrarySavedQuickViewPreset[] {
  if (typeof window === 'undefined') {
    return [];
  }

  const next = loadSavedQuickViewPresets(libraryId).filter((preset) => preset.id !== presetId);
  window.localStorage.setItem(toPresetStorageKey(libraryId), JSON.stringify(next));
  return next;
}
