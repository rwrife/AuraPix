import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import type { SidebarItem, LinkSidebarItem, ParentSidebarItem, ChildSidebarItem } from './types';

interface SidebarNavProps {
  /** Main navigation items (scrollable) */
  topItems: SidebarItem[];
  /** Sticky bottom items (e.g., settings) */
  bottomItems?: SidebarItem[];
}

export function SidebarNav({ topItems, bottomItems }: SidebarNavProps) {
  return (
    <nav className="app-sidebar">
      <div className="sidebar-top">
        {topItems.map((item) => (
          <SidebarItemComponent key={item.id} item={item} />
        ))}
      </div>
      {bottomItems && bottomItems.length > 0 && (
        <div className="sidebar-bottom">
          {bottomItems.map((item) => (
            <SidebarItemComponent key={item.id} item={item} />
          ))}
        </div>
      )}
    </nav>
  );
}

interface SidebarItemComponentProps {
  item: SidebarItem;
}

function SidebarItemComponent({ item }: SidebarItemComponentProps) {
  if (item.type === 'link') {
    return <LinkItem item={item as LinkSidebarItem} />;
  }
  return <ParentItem item={item as ParentSidebarItem} />;
}

interface LinkItemProps {
  item: LinkSidebarItem;
}

function LinkItem({ item }: LinkItemProps) {
  const navClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? 'sidebar-link active' : 'sidebar-link';

  return (
    <NavLink to={item.to} className={navClass} end={item.end}>
      {item.icon && <span className="sidebar-icon">{item.icon}</span>}
      <span>{item.label}</span>
    </NavLink>
  );
}

interface ParentItemProps {
  item: ParentSidebarItem;
}

function ParentItem({ item }: ParentItemProps) {
  const [isExpanded, setIsExpanded] = useState(item.defaultExpanded ?? false);

  const navClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? 'sidebar-link active' : 'sidebar-link';

  // Group children by groupLabel
  const groupedChildren: Record<string, ChildSidebarItem[]> = {};
  const ungroupedChildren: ChildSidebarItem[] = [];

  item.children.forEach((child) => {
    if (child.groupLabel) {
      if (!groupedChildren[child.groupLabel]) {
        groupedChildren[child.groupLabel] = [];
      }
      groupedChildren[child.groupLabel].push(child);
    } else {
      ungroupedChildren.push(child);
    }
  });

  return (
    <div className="sidebar-section">
      {item.to ? (
        <NavLink to={item.to} className={navClass} end={item.end ?? true}>
          {item.icon && <span className="sidebar-icon">{item.icon}</span>}
          <span>{item.label}</span>
        </NavLink>
      ) : (
        <button
          className="sidebar-link"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded ? 'true' : 'false'}
        >
          {item.icon && <span className="sidebar-icon">{item.icon}</span>}
          <span>{item.label}</span>
        </button>
      )}

      {isExpanded && item.children.length > 0 && (
        <>
          {/* Render grouped children */}
          {Object.entries(groupedChildren).map(([groupLabel, children]) => (
            <div key={groupLabel} className="sidebar-folder">
              <span className="sidebar-folder-label">{groupLabel}</span>
              <ul className="sidebar-album-list">
                {children.map((child) => (
                  <li key={child.id}>
                    <NavLink to={child.to} className={navClass}>
                      {child.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* Render ungrouped children */}
          {ungroupedChildren.length > 0 && (
            <ul className="sidebar-album-list">
              {ungroupedChildren.map((child) => (
                <li key={child.id}>
                  <NavLink to={child.to} className={navClass}>
                    {child.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
