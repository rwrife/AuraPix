import type { ReactNode } from 'react';

/**
 * Base configuration for all toolbar buttons
 */
export interface BaseToolbarButton {
  id: string;
  icon: string;
  title: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Toggle button - directly executes action on click (e.g., favorite)
 */
export interface ToggleToolbarButton extends BaseToolbarButton {
  type: 'toggle';
  isActive?: boolean;
  onClick: () => void | Promise<void>;
}

/**
 * Modal button - opens a modal dialog with custom content (e.g., delete confirmation)
 */
export interface ModalToolbarButton extends BaseToolbarButton {
  type: 'modal';
  /** Component to render inside the modal */
  modalContent: ReactNode | ((props: ModalContentProps) => ReactNode);
  /** Optional modal title override (defaults to button title) */
  modalTitle?: string;
  /** Optional modal size */
  modalSize?: 'small' | 'medium' | 'large';
}

/**
 * Panel button - opens a slide-out settings panel (e.g., comments, edit tools)
 */
export interface PanelToolbarButton extends BaseToolbarButton {
  type: 'panel';
  /** Component to render inside the panel */
  panelContent: ReactNode | ((props: PanelContentProps) => ReactNode);
  /** Optional panel title override (defaults to button title) */
  panelTitle?: string;
  /** Whether this panel is currently active */
  isActive?: boolean;
}

/**
 * Union type of all toolbar button types
 */
export type ToolbarButton = ToggleToolbarButton | ModalToolbarButton | PanelToolbarButton;

/**
 * Props passed to modal content components
 */
export interface ModalContentProps {
  /** Call this to close the modal */
  onClose: () => void;
}

/**
 * Props passed to panel content components
 */
export interface PanelContentProps {
  /** Call this to close the panel */
  onClose: () => void;
}

/**
 * Configuration for the toolbar
 */
export interface ToolbarConfig {
  buttons: ToolbarButton[];
}
