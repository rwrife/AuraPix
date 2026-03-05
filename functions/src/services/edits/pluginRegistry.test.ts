import { describe, expect, it } from 'vitest';
import { resolveEnabledPluginIdsForTest } from './pluginRegistry.js';

describe('pluginRegistry env controls', () => {
  it('uses defaults when no env overrides are set', () => {
    const enabled = resolveEnabledPluginIdsForTest({});

    expect(enabled).toEqual(new Set(['crop', 'rotate', 'adjust', 'filter']));
  });

  it('supports allow-list mode via AURAPIX_EDIT_ENABLED_PLUGINS', () => {
    const enabled = resolveEnabledPluginIdsForTest({
      AURAPIX_EDIT_ENABLED_PLUGINS: 'crop,adjust',
    });

    expect(enabled).toEqual(new Set(['crop', 'adjust']));
  });

  it('supports deny-list mode via AURAPIX_EDIT_DISABLED_PLUGINS', () => {
    const enabled = resolveEnabledPluginIdsForTest({
      AURAPIX_EDIT_DISABLED_PLUGINS: 'filter',
    });

    expect(enabled).toEqual(new Set(['crop', 'rotate', 'adjust']));
  });

  it('applies disabled list after enabled list for safety', () => {
    const enabled = resolveEnabledPluginIdsForTest({
      AURAPIX_EDIT_ENABLED_PLUGINS: 'crop,adjust,filter',
      AURAPIX_EDIT_DISABLED_PLUGINS: 'filter',
    });

    expect(enabled).toEqual(new Set(['crop', 'adjust']));
  });
});
