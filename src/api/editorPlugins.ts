/**
 * Frontend client for the editor plugin manifest (issue #166).
 *
 * Wraps `GET /edits/plugins`. When called with a `tenantId` or `libraryId`
 * the server intersects the global manifest with the per-tenant allowlist
 * so disabled plugins are surfaced as `enabled: false`.
 *
 * Editor toolbars should call `listEnabledPluginIds` (or filter the full
 * manifest by `enabled === true`) so that disabled plugins are hidden from
 * the user. This is *not* a security boundary \u2014 the runtime executor
 * enforces the allowlist server-side and rejects disabled plugins with a
 * `403 plugin_disabled_for_tenant` regardless of what the UI shows.
 */

import { getApiUrl } from '../config/api';

export interface EditorPluginEntry {
  id: string;
  displayName?: string;
  /** True when the plugin is enabled both globally AND for the active tenant. */
  enabled: boolean;
}

export interface EditorPluginsResponse {
  recipeVersion: number;
  /** Echoed when the request resolved a tenant context. */
  tenantId?: string;
  plugins: EditorPluginEntry[];
}

export interface FetchEditorPluginsOptions {
  /** Caller's auth bearer token (Firebase ID token). */
  authToken: string;
  /** Optional tenant context. When provided, response reflects per-tenant state. */
  tenantId?: string;
  /** Alternative way to address tenant context (server resolves to `lib:<id>`). */
  libraryId?: string;
  /** Optional fetch override (testing). */
  fetchImpl?: typeof fetch;
}

export async function fetchEditorPlugins(
  options: FetchEditorPluginsOptions
): Promise<EditorPluginsResponse> {
  const { authToken, tenantId, libraryId, fetchImpl = fetch } = options;
  const url = new URL(getApiUrl('/edits/plugins'));
  if (tenantId) url.searchParams.set('tenantId', tenantId);
  if (libraryId) url.searchParams.set('libraryId', libraryId);

  const res = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${authToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to load editor plugins: ${res.status}`);
  }
  return (await res.json()) as EditorPluginsResponse;
}

/**
 * Convenience helper: returns only the enabled plugin ids for the tenant
 * context. Editor toolbars can use this to filter their button list.
 */
export async function listEnabledPluginIds(
  options: FetchEditorPluginsOptions
): Promise<string[]> {
  const result = await fetchEditorPlugins(options);
  return result.plugins.filter((p) => p.enabled).map((p) => p.id);
}
