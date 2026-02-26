import { useState } from "react";
import { createPortal } from "react-dom";
import type {
  ToolbarButton,
  ToggleToolbarButton,
  ModalToolbarButton,
} from "./types";

interface ToolbarButtonProps {
  button: ToolbarButton;
  activePanel: string | null;
  onPanelChange: (panelId: string | null) => void;
}

export function ToolbarButtonComponent({
  button,
  activePanel,
  onPanelChange,
}: ToolbarButtonProps) {
  const [showModal, setShowModal] = useState(false);

  const handleClick = () => {
    switch (button.type) {
      case "toggle":
        (button as ToggleToolbarButton).onClick();
        break;
      case "modal":
        setShowModal(true);
        break;
      case "panel": {
        onPanelChange(activePanel === button.id ? null : button.id);
        break;
      }
    }
  };

  const isActive =
    button.type === "toggle"
      ? (button as ToggleToolbarButton).isActive
      : button.type === "panel"
        ? activePanel === button.id
        : false;

  return (
    <>
      <button
        className={`right-toolbar-icon ${button.className || "btn-ghost"}${isActive ? " active" : ""}`}
        title={button.title}
        onClick={handleClick}
        disabled={button.disabled}
        aria-label={button.title}
      >
        {button.icon}
      </button>

      {button.type === "modal" && showModal && (
        <ModalDialog
          button={button as ModalToolbarButton}
          onClose={() => setShowModal(false)}
        />
      )}
    </>
  );
}

interface ModalDialogProps {
  button: ModalToolbarButton;
  onClose: () => void;
}

function ModalDialog({ button, onClose }: ModalDialogProps) {
  const content =
    typeof button.modalContent === "function"
      ? button.modalContent({ onClose })
      : button.modalContent;

  const modalElement = (
    <div className="confirm-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className={`confirm-modal${button.modalSize === "large" ? " confirm-modal--large" : button.modalSize === "small" ? " confirm-modal--small" : ""}`}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="settings-panel-title">{button.modalTitle || button.title}</h3>
        {content}
      </div>
    </div>
  );

  // Render modal at document.body level to escape toolbar container
  return createPortal(modalElement, document.body);
}
