/** 16-point compass rose — the Dezfil mark. */
export function Compass({ size = 20 }: { size?: number }) {
  const spokes = [];
  for (let i = 0; i < 16; i++) {
    const angle = (i * Math.PI) / 8;
    const major = i % 4 === 0;
    const r = major ? 9.5 : i % 2 === 0 ? 7 : 4.5;
    spokes.push(
      <line
        key={i}
        x1={10}
        y1={10}
        x2={10 + r * Math.sin(angle)}
        y2={10 - r * Math.cos(angle)}
        strokeWidth={major ? 1.1 : 0.55}
      />,
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      aria-hidden
    >
      <circle cx={10} cy={10} r={9.6} strokeWidth={0.5} opacity={0.5} />
      {spokes}
      <circle cx={10} cy={10} r={1.4} fill="currentColor" stroke="none" />
    </svg>
  );
}
