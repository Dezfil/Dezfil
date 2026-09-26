import type { RgbaColor } from "./style";

export function toHex(c: RgbaColor): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function fromHex(hex: string, alpha: number): RgbaColor {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
    a: alpha,
  };
}

export function rgbaCss(c: RgbaColor): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}
