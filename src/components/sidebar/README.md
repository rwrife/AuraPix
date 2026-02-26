# Extensible Sidebar Navigation System

An extensible, plugin-oriented sidebar navigation system. Supports two item types: simple links and collapsible parent items with nested children.

## Item Types

### 1. Link Item
Simple navigation link (e.g., Library, Recent, Favorites).

```tsx
{
  type: "link",
  id: "library",
  label: "Library",
  to: "/library",
  icon: <LibraryIcon />,
  end: true,  // exact match
}
```

### 2. Parent Item
Collapsible section with child links (e.g., Albums with sub-albums).

```tsx
{
  type: "parent",
  id: "albums",
  label: "Albums",
  to: "/albums",  // optional parent link
  icon: <AlbumsIcon />,
  children: [
    {
      id: "album-1",
      label: "Vacation Photos",
      to: "/albums/album-1",
    },
    {
      id: "album-2",
      label: "Family",
      to: "/albums/album-2",
      groupLabel: "Personal",  // optional grouping
    },
  ],
  defaultExpanded: true,  // start expanded
}
```

## Usage

```tsx
import { SidebarNav } from "../components/sidebar";
import type { SidebarItem } from "../components/sidebar";

const sidebarItems: SidebarItem[] = [
  {
    type: "link",
    id: "library",
    label: "Library",
    to: "/library",
    icon: <LibraryIcon />,
  },
  {
    type: "parent",
    id: "albums",
    label: "Albums",
    to: "/albums",
    icon: <AlbumsIcon />,
    children: albumsList.map(album => ({
      id: album.id,
      label: album.name,
      to: `/albums/${album.id}`,
    })),
    defaultExpanded: true,
  },
];

<SidebarNav items={sidebarItems} />
```

## Complete Example

```tsx
import { useMemo } from "react";
import { SidebarNav } from "../components/sidebar";
import type { SidebarItem } from "../components/sidebar";

function MyLayout() {
  const { albums, folders } = useAlbums();

  const sidebarItems = useMemo<SidebarItem[]>(() => {
    return [
      // Simple links
      {
        type: "link",
        id: "library",
        label: "Library",
        to: "/library",
        icon: <LibraryIcon />,
        end: true,
      },
      {
        type: "link",
        id: "favorites",
        label: "Favorites",
        to: "/favorites",
        icon: <FavoritesIcon />,
      },
      
      // Parent with grouped children
      {
        type: "parent",
        id: "albums",
        label: "Albums",
        to: "/albums",
        icon: <AlbumsIcon />,
        children: [
          // Grouped by folder
          ...folders.flatMap(folder =>
            albums
              .filter(a => a.folderId === folder.id)
              .map(album => ({
                id: album.id,
                label: album.name,
                to: `/albums/${album.id}`,
                groupLabel: folder.name,
              }))
          ),
          // Ungrouped albums
          ...albums
            .filter(a => !a.folderId)
            .map(album => ({
              id: album.id,
              label: album.name,
              to: `/albums/${album.id}`,
            })),
        ],
        defaultExpanded: true,
      },
    ];
  }, [albums, folders]);

  return (
    <div className="app-shell">
      <div className="app-body">
        <SidebarNav items={sidebarItems} />
        <main>{/* content */}</main>
      </div>
    </div>
  );
}
```

## Third-Party Extensions

To create a third-party sidebar extension:

1. Create your sidebar item configuration:

```tsx
// my-extension/sidebar-config.ts
import type { SidebarItem } from "@aurapix/components/sidebar";

export function createMyExtensionSidebarItem(): SidebarItem {
  return {
    type: "parent",
    id: "my-extension",
    label: "My Extension",
    to: "/my-extension",
    icon: <MyIcon />,
    children: [
      {
        id: "sub-1",
        label: "Sub Item 1",
        to: "/my-extension/sub-1",
      },
    ],
    defaultExpanded: false,
  };
}
```

2. Add it to the sidebar configuration:

```tsx
const sidebarItems = useMemo<SidebarItem[]>(() => {
  return [
    ...standardItems,
    createMyExtensionSidebarItem(),
  ];
}, [standardItems]);
```

## Props Reference

### LinkSidebarItem
- `type`: `"link"`
- `id` (string, required): Unique identifier
- `label` (string, required): Display text
- `to` (string, required): Navigation path
- `icon` (ReactNode): Optional icon component
- `end` (boolean): Whether to match path exactly (default: false)

### ParentSidebarItem
- `type`: `"parent"`
- `id` (string, required): Unique identifier
- `label` (string, required): Display text
- `to` (string): Optional navigation path for parent
- `icon` (ReactNode): Optional icon component
- `end` (boolean): Whether to match parent path exactly (default: true)
- `children` (ChildSidebarItem[], required): Array of child items
- `defaultExpanded` (boolean): Whether section starts expanded (default: false)

### ChildSidebarItem
- `id` (string, required): Unique identifier
- `label` (string, required): Display text
- `to` (string, required): Navigation path
- `groupLabel` (string): Optional group heading for organizing children

## Features

✅ **Extensible Design** - Easy to add new navigation items
✅ **Type-Safe** - Full TypeScript support
✅ **Collapsible Sections** - Parent items can expand/collapse
✅ **Grouped Children** - Organize child items under group headings
✅ **Active State** - Automatic active link highlighting via React Router
✅ **Icon Support** - Optional icons for all items