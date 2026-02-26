import { useState } from "react";
import type { ToolbarButton, PanelToolbarButton } from "./types";
import { ToolbarButtonComponent } from "./ToolbarButton";

interface ToolbarProps {
  buttons: ToolbarButton[];
  /** Aria label for the toolbar */
  ariaLabel?: string;
}

export function Toolbar({ buttons, ariaLabel }: ToolbarProps) {
  const [activePanel, setActivePanel] = useState<string | null>(null);

  const activePanelButton = buttons.find(
    (b) => b.type === "panel" && b.id === activePanel
  ) as PanelToolbarButton | undefined;

  return (
    <>
      <aside className="page-right-column" aria-label={ariaLabel}>
        {buttons.map((button) => (
          <ToolbarButtonComponent
            key={button.id}
            button={button}
            activePanel={activePanel}
            onPanelChange={setActivePanel}
          />
        ))}

        {activePanelButton && (
          <div className="settings-panel">
            <h3 className="settings-panel-title">
              {activePanelButton.panelTitle || activePanelButton.title}
            </h3>
            {typeof activePanelButton.panelContent === "function"
              ? activePanelButton.panelContent({ onClose: () => setActivePanel(null) })
              : activePanelButton.panelContent}
          </div>
        )}
      </aside>
    </>
  );
}