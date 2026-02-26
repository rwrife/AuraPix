import { useState, useEffect } from 'react';
import type { ToolbarButton, PanelToolbarButton } from './types';
import { ToolbarButtonComponent } from './ToolbarButton';

interface ViewerToolbarProps {
  buttons: ToolbarButton[];
  /** Aria label for the toolbar */
  ariaLabel?: string;
}

export function ViewerToolbar({ buttons, ariaLabel }: ViewerToolbarProps) {
  const [activePanel, setActivePanel] = useState<string | null>(null);

  const activePanelButton = buttons.find((b) => b.type === 'panel' && b.id === activePanel) as
    | PanelToolbarButton
    | undefined;

  // ESC key to close panel
  useEffect(() => {
    if (!activePanel) return;

    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setActivePanel(null);
      }
    }

    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [activePanel]);

  return (
    <>
      {/* Slide-out panel for viewer tools */}
      <div className={`viewer-slide-panel${activePanel ? ' open' : ''}`}>
        <div className="viewer-slide-panel-header">
          <h3 className="viewer-slide-panel-title">
            {activePanelButton?.panelTitle || activePanelButton?.title || ''}
          </h3>
          <button
            className="viewer-slide-panel-close"
            onClick={() => setActivePanel(null)}
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
        <div className="viewer-slide-panel-body">
          {activePanelButton &&
            (typeof activePanelButton.panelContent === 'function'
              ? activePanelButton.panelContent({ onClose: () => setActivePanel(null) })
              : activePanelButton.panelContent)}
        </div>
      </div>

      <aside className="page-right-column" aria-label={ariaLabel}>
        {buttons.map((button) => (
          <ToolbarButtonComponent
            key={button.id}
            button={button}
            activePanel={activePanel}
            onPanelChange={setActivePanel}
          />
        ))}
      </aside>
    </>
  );
}
