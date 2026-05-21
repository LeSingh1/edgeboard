import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Accent palette helpers — rotate through 5 colors by index. */
export const ACCENTS = [
  "accent-1", // magenta
  "accent-2", // cyan
  "accent-3", // yellow
  "accent-4", // orange
  "accent-5", // purple
] as const;

export const ACCENT_HEX: Record<(typeof ACCENTS)[number], string> = {
  "accent-1": "#FF3AF2",
  "accent-2": "#00F5D4",
  "accent-3": "#FFE600",
  "accent-4": "#FF6B35",
  "accent-5": "#7B2FFF",
};

export function accentFor(i: number) {
  return ACCENTS[i % ACCENTS.length];
}

export function accentHexFor(i: number) {
  return ACCENT_HEX[accentFor(i)];
}
