export type EditOperationType = 'crop' | 'rotate' | 'adjust' | 'filter';

export interface EditPluginManifest {
  id: EditOperationType;
  displayName: string;
  version: string;
  enabledByDefault: boolean;
  nonDestructive: boolean;
  params: string[];
}

export interface RuntimeEditPluginManifest extends EditPluginManifest {
  enabled: boolean;
}

export const EDIT_RECIPE_VERSION = 1;

export const EDIT_PLUGIN_MANIFEST: EditPluginManifest[] = [
  {
    id: 'crop',
    displayName: 'Crop',
    version: '1.0.0',
    enabledByDefault: true,
    nonDestructive: true,
    params: ['x', 'y', 'width', 'height'],
  },
  {
    id: 'rotate',
    displayName: 'Rotate',
    version: '1.0.0',
    enabledByDefault: true,
    nonDestructive: true,
    params: ['degrees'],
  },
  {
    id: 'adjust',
    displayName: 'Adjust',
    version: '1.0.0',
    enabledByDefault: true,
    nonDestructive: true,
    params: ['brightness', 'contrast', 'saturation'],
  },
  {
    id: 'filter',
    displayName: 'Filter',
    version: '1.0.0',
    enabledByDefault: true,
    nonDestructive: true,
    params: ['filterName', 'sigma'],
  },
];

const ALL_PLUGIN_IDS = new Set(EDIT_PLUGIN_MANIFEST.map((plugin) => plugin.id));

function parsePluginList(value: string | undefined): Set<EditOperationType> {
  if (!value) return new Set();

  return new Set(
    value
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token): token is EditOperationType => ALL_PLUGIN_IDS.has(token as EditOperationType))
  );
}

function buildEnabledPluginIds(env: NodeJS.ProcessEnv = process.env): Set<EditOperationType> {
  const enabledFromEnv = parsePluginList(env.AURAPIX_EDIT_ENABLED_PLUGINS);
  const disabledFromEnv = parsePluginList(env.AURAPIX_EDIT_DISABLED_PLUGINS);

  const enabled =
    enabledFromEnv.size > 0
      ? new Set(enabledFromEnv)
      : new Set(
          EDIT_PLUGIN_MANIFEST.filter((plugin) => plugin.enabledByDefault).map((plugin) => plugin.id)
        );

  for (const pluginId of disabledFromEnv) {
    enabled.delete(pluginId);
  }

  return enabled;
}

const ENABLED_PLUGIN_IDS = buildEnabledPluginIds();

export function listPlugins(): RuntimeEditPluginManifest[] {
  return EDIT_PLUGIN_MANIFEST.map((plugin) => ({
    ...plugin,
    enabled: ENABLED_PLUGIN_IDS.has(plugin.id),
  }));
}

export function isPluginEnabled(type: string): type is EditOperationType {
  return ENABLED_PLUGIN_IDS.has(type as EditOperationType);
}

export function resolveEnabledPluginIdsForTest(
  env: NodeJS.ProcessEnv = process.env
): Set<EditOperationType> {
  return buildEnabledPluginIds(env);
}
