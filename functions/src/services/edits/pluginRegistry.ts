export type EditOperationType = 'crop' | 'rotate' | 'adjust' | 'filter';

export interface EditPluginManifest {
  id: EditOperationType;
  displayName: string;
  version: string;
  enabledByDefault: boolean;
  nonDestructive: boolean;
  params: string[];
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

const ENABLED_PLUGIN_IDS = new Set(
  EDIT_PLUGIN_MANIFEST.filter((plugin) => plugin.enabledByDefault).map(
    (plugin) => plugin.id
  )
);

export function isPluginEnabled(type: string): type is EditOperationType {
  return ENABLED_PLUGIN_IDS.has(type as EditOperationType);
}
