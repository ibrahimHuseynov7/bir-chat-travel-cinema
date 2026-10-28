import type { Route } from "@/lib/bir";

const CELLS: Record<Route, string> = {
  general: "50,6 72,43 50,80 28,43",
  cinema: "28,43 50,80 6,80",
  avia: "72,43 94,80 50,80",
  shopping: "6,80 50,80 28,117",
};

export function BirLogo({ active, className = "h-[42px] w-[26px]" }: { active?: Route | null; className?: string }) {
  return (
    <svg viewBox="0 0 100 160" className={className} aria-hidden="true">
      {(Object.keys(CELLS) as Route[]).map((k) => (
        <polygon key={k} points={CELLS[k]} className="logo-cell" fill={active === k ? "currentColor" : "transparent"} />
      ))}
      <g fill="none" stroke="currentColor" strokeWidth="10" strokeLinejoin="round" strokeLinecap="round">
        <polygon points="50,6 94,80 50,154 6,80" />
        <line x1="28" y1="43" x2="72" y2="117" />
        <line x1="72" y1="43" x2="28" y2="117" />
        <line x1="6" y1="80" x2="94" y2="80" />
      </g>
    </svg>
  );
}
