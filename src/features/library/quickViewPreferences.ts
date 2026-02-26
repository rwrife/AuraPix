export type LibraryQuickCollectionSelection = 'all' | 'favorites' | 'untagged' | 'recent';

export interface LibraryQuickViewPreferences {
  quickCollection: LibraryQuickCollectionSelection;
  activeTagFilter: string;
  cameraMakeFilter: string;
}

const STORAGE_KEY_PREFIX = 'aurapix.library.quick-view';

const DEFAULT_PREFERENCES: LibraryQuickViewPreferences = {
  quickCollection: 'all',
  activeTagFilter: '',
  cameraMakeFilter: '',
};

function toStorageKey(libraryId: string) {
  return `${STORAGE_KEY_PREFIX}.${libraryId}`;
}

function normalizeQuickCollection(value: unknown): LibraryQuickCollectionSelection {
  if (value === 'all' || value === 'favorites' || value === 'untagged' || value === 'recent') {
    return value;
  }

  return DEFAULT_PREFERENCES.quickCollection;
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
