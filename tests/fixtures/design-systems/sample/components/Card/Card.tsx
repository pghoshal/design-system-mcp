type ReactNode = unknown;

export interface CardProps {
  /** Short heading shown at the top of the card. */
  title: string;
  /** Visual tone for the card container. */
  tone?: "neutral" | "accent" | "danger";
  /** Card body content. */
  children?: ReactNode;
}

export function Card(_props: CardProps): null {
  return null;
}
