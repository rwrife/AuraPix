# Extensible Toolbar System

An extensible, plugin-oriented toolbar system for the right column of pages. Supports three button types with custom content components.

## Button Types

### 1. Toggle Button
Directly executes an action on click (e.g., favorite toggle).

```tsx
{
  type: "toggle",
  id: "favorite",
  icon: "♥",
  title: "Favorite",
  isActive: photo.isFavorite,
  onClick: () => toggleFavorite(photo.id),
}
```

### 2. Modal Button
Opens a modal dialog with custom content (e.g., delete confirmation).

```tsx
{
  type: "modal",
  id: "delete",
  icon: "🗑",
  title: "Delete",
  className: "btn-danger-ghost",
  modalTitle: "Delete photo?",
  modalContent: ({ onClose }) => (
    <>
      <p>Are you sure?</p>
      <div className="confirm-modal-actions">
        <button onClick={onClose}>Cancel</button>
        <button onClick={() => {
          performDelete();
          onClose();
        }}>Delete</button>
      </div>
    </>
  ),
}
```

### 3. Panel Button
Opens a slide-out settings panel (e.g., comments, edit tools).

```tsx
{
  type: "panel",
  id: "edit",
  icon: "🎚",
  title: "Edit",
  panelContent: (
    <>
      <label>Brightness</label>
      <input type="range" value={brightness} onChange={...} />
    </>
  ),
}
```

## Usage

### Standard Toolbar (for gallery/list views)

```tsx
import { Toolbar } from "../components/toolbar";
import type { ToolbarButton } from "../components/toolbar";

const toolbarButtons: ToolbarButton[] = [
  // ... button configurations
];

<Toolbar buttons={toolbarButtons} ariaLabel="Photo tools" />
```

### Viewer Toolbar (for photo viewer with slide-out panel)

```tsx
import { ViewerToolbar } from "../components/toolbar";

<ViewerToolbar buttons={viewerToolbarButtons} ariaLabel="Viewer tools" />
```

## Complete Example

```tsx
import { useMemo } from "react";
import { Toolbar } from "../components/toolbar";
import type { ToolbarButton, ModalContentProps } from "../components/toolbar";

function MyPage() {
  const toolbarButtons = useMemo<ToolbarButton[]>(() => {
    return [
      // Toggle button
      {
        type: "toggle",
        id: "favorite",
        icon: "♥",
        title: "Toggle favorite",
        isActive: isFavorite,
        onClick: handleToggleFavorite,
      },
      
      // Modal button
      {
        type: "modal",
        id: "delete",
        icon: "✕",
        title: "Delete",
        className: "btn-danger-ghost",
        modalTitle: "Confirm deletion",
        modalContent: ({ onClose }: ModalContentProps) => (
          <>
            <p>Are you sure?</p>
            <div className="confirm-modal-actions">
              <button onClick={onClose}>Cancel</button>
              <button onClick={() => {
                handleDelete();
                onClose();
              }}>Delete</button>
            </div>
          </>
        ),
      },
      
      // Panel button
      {
        type: "panel",
        id: "settings",
        icon: "⚙",
        title: "Settings",
        panelContent: ({ onClose }) => (
          <>
            <button onClick={onClose}>Save and Close</button>
          </>
        ),
      },
    ];
  }, [isFavorite, handleToggleFavorite, handleDelete]);

  return (
    <div className="page-with-toolbar">
      <div className="page-center-column">
        {/* Main content */}
      </div>
      <Toolbar buttons={toolbarButtons} ariaLabel="My tools" />
    </div>
  );
}
```

## Third-Party Extensions

To create a third-party extension:

1. Create your button configuration function:

```tsx
// my-extension/toolbar-config.ts
import type { ToolbarButton } from "@aurapix/components/toolbar";

export function createMyExtensionButton(): ToolbarButton {
  return {
    type: "panel",
    id: "my-extension",
    icon: "🎨",
    title: "My Extension",
    panelContent: <MyExtensionPanel />,
  };
}
```

2. Add it to the toolbar:

```tsx
const toolbarButtons = useMemo<ToolbarButton[]>(() => {
  return [
    ...standardButtons,
    createMyExtensionButton(),
  ];
}, [standardButtons]);
```

## Props Reference

### ToolbarButton (base interface)
- `id` (string, required): Unique identifier
- `icon` (string, required): Icon to display (emoji or text)
- `title` (string, required): Tooltip text
- `disabled` (boolean): Whether button is disabled
- `className` (string): Additional CSS classes

### ToggleToolbarButton extends ToolbarButton
- `type`: `"toggle"`
- `isActive` (boolean): Whether toggle is active
- `onClick` (function): Handler for click

### ModalToolbarButton extends ToolbarButton
- `type`: `"modal"`
- `modalContent` (ReactNode | function): Content to render in modal
- `modalTitle` (string): Modal title (defaults to button title)
- `modalSize` (`"small" | "medium" | "large"`): Modal size

### PanelToolbarButton extends ToolbarButton
- `type`: `"panel"`
- `panelContent` (ReactNode | function): Content to render in panel
- `panelTitle` (string): Panel title (defaults to button title)

## Content Props

### ModalContentProps
- `onClose` (function): Call to close the modal

### PanelContentProps
- `onClose` (function): Call to close the panel