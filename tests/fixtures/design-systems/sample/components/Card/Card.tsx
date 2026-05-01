type ReactNode = unknown;

export interface CardProps {
  /** Short heading shown at the top of the card. */
  title: string;
  /**
   * Visual tone for the card container.
   * @default "neutral"
   */
  tone?: "neutral" | "accent" | "danger";
  /**
   * Legacy tone prop kept for migration examples.
   * @deprecated Use tone instead.
   */
  legacyTone?: "neutral" | "accent";
  /** Controlled expanded state for disclosure cards. */
  expanded?: boolean;
  /** Card body content. */
  children?: ReactNode;
}

export function Card(_props: CardProps): null {
  return null;
}
