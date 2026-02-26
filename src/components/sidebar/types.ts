import type { ReactNode } from "react";

/**
 * Base configuration for all sidebar items
 */
export interface BaseSidebarItem {
  id: string;
  label: string;
  icon?: ReactNode;
}

/**
 * Simple link navigation item (e.g., Library, Recent, Favorites)
 */
export interface LinkSidebarItem extends BaseSidebarItem {
  type: "link";
  to: string;
  /** Whether to match exactly (default: false) */
  end?: boolean;
}

/**
 * Collapsible section with child links (e.g., Albums with sub-albums)
 */
export interface ParentSidebarItem extends BaseSidebarItem {
  type: "parent";
  to?: string;
  /** Whether to match exactly for parent link (default: true) */
  end?: boolean;
  /** Child navigation items */
  children: ChildSidebarItem[];
  /** Whether section starts expanded (default: false) */
  defaultExpanded?: boolean;
}

/**
 * Child link within a parent section
 */
export interface ChildSidebarItem {
  id: string;
  label: string;
  to: string;
  /** Optional grouping label for child items */
  groupLabel?: string;
}

/**
 * Union type of all sidebar item types
 */
export type SidebarItem = LinkSidebarItem | ParentSidebarItem;

/**
 * Configuration for the sidebar with top (scrollable) and bottom (sticky) sections
 */
export interface SidebarConfig {
  /** Main navigation items (scrollable when overflow) */
  topItems: SidebarItem[];
  /** Sticky items at the bottom (e.g., settings) */
  bottomItems?: SidebarItem[];
}
