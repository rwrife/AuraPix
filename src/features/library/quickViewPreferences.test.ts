import {
  loadQuickViewPreferences,
  saveQuickViewPreferences,
  type LibraryQuickViewPreferences,
} from './quickViewPreferences';

const LIBRARY_ID = 'library-local-user-1';

describe('quickViewPreferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns defaults when no saved preferences exist', () => {
    expect(loadQuickViewPreferences(LIBRARY_ID)).toEqual({
      quickCollection: 'all',
      activeTagFilter: '',
      cameraMakeFilter: '',
    });
  });

  it('saves and loads preferences for a library id', () => {
    const preferences: LibraryQuickViewPreferences = {
      quickCollection: 'favorites',
      activeTagFilter: 'trip',
      cameraMakeFilter: 'Canon',
    };

    saveQuickViewPreferences(LIBRARY_ID, preferences);

    expect(loadQuickViewPreferences(LIBRARY_ID)).toEqual(preferences);
  });

  it('falls back to defaults for invalid quickCollection values', () => {
    localStorage.setItem(
      'aurapix.library.quick-view.library-local-user-1',
      JSON.stringify({
        quickCollection: 'not-a-real-collection',
        activeTagFilter: 'family',
        cameraMakeFilter: 'Nikon',
      })
    );

    expect(loadQuickViewPreferences(LIBRARY_ID)).toEqual({
      quickCollection: 'all',
      activeTagFilter: 'family',
      cameraMakeFilter: 'Nikon',
    });
  });
});
