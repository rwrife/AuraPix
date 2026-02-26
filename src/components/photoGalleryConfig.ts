export type GridMode = "small" | "medium" | "large";

export const GRID_BUTTONS: { mode: GridMode; icon: string; title: string }[] = [
  { mode: "small", icon: "⊟", title: "Small tiles (128×128)" },
  { mode: "medium", icon: "⊞", title: "Medium tiles (256×256)" },
  { mode: "large", icon: "▣", title: "Large tiles (320×320)" },
];
