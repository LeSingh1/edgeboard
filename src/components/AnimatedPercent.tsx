"use client";

import { animate, useMotionValue, useTransform, motion } from "framer-motion";
import { useEffect } from "react";

interface AnimatedPercentProps {
  value: number;        // 0..1
  decimals?: number;
  className?: string;
}

/** Smooth animated number for the hit-probability counter. */
export function AnimatedPercent({
  value,
  decimals = 1,
  className,
}: AnimatedPercentProps) {
  const mv = useMotionValue(0);
  const display = useTransform(mv, (v) => `${(v * 100).toFixed(decimals)}%`);

  useEffect(() => {
    const controls = animate(mv, value, {
      duration: 0.7,
      ease: [0.22, 1, 0.36, 1],
    });
    return () => controls.stop();
  }, [mv, value]);

  return <motion.span className={className}>{display}</motion.span>;
}
