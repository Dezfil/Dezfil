"use client";
import { useEffect, useState } from "react";
import { readPaintedStyle } from "@/lib/pictures/declaration";
export function usePaintedStyle(): string | null {
  const [painted, setPainted] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setPainted(readPaintedStyle(document));
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-painted-basemap"] });
    const timer = setTimeout(read, 0);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, []);
  return painted;
}
