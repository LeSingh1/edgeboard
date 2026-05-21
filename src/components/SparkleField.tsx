"use client";

import { motion } from "framer-motion";
import { Sparkles, Star, Circle, Triangle, Zap, Diamond } from "lucide-react";
import { useMemo } from "react";
import { ACCENT_HEX, ACCENTS } from "@/lib/cn";

const SHAPES = [Sparkles, Star, Circle, Triangle, Zap, Diamond] as const;

interface SparkleFieldProps {
  count?: number;
  className?: string;
}

/**
 * Floating decorative SVG shapes scattered across the viewport.
 * Maximalism rule: 5–10 shapes per full-height section.
 */
export function SparkleField({ count = 9, className = "" }: SparkleFieldProps) {
  const shapes = useMemo(() => {
    return Array.from({ length: count }).map((_, i) => {
      const Shape = SHAPES[i % SHAPES.length];
      const accent = ACCENTS[i % ACCENTS.length];
      return {
        Shape,
        color: ACCENT_HEX[accent],
        top: `${5 + ((i * 37) % 85)}%`,
        left: `${4 + ((i * 53) % 92)}%`,
        size: 18 + (i % 4) * 14,
        rotate: (i * 47) % 360,
        delay: (i % 5) * 0.6,
        duration: 4 + (i % 4),
        anim: i % 3 === 0 ? "spin" : i % 3 === 1 ? "float" : "wiggle",
      };
    });
  }, [count]);

  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-0 z-0 overflow-hidden ${className}`}
    >
      {shapes.map((s, i) => (
        <motion.div
          key={i}
          className="absolute"
          style={{ top: s.top, left: s.left, color: s.color }}
          initial={{ opacity: 0, scale: 0 }}
          animate={
            s.anim === "spin"
              ? { opacity: 0.4, scale: 1, rotate: 360 }
              : s.anim === "float"
                ? { opacity: 0.4, scale: 1, y: [0, -20, 0] }
                : { opacity: 0.4, scale: 1, rotate: [-15, 15, -15] }
          }
          transition={{
            opacity: { duration: 0.8, delay: s.delay },
            scale: { duration: 0.8, delay: s.delay, type: "spring" },
            rotate: { duration: s.duration * 3, repeat: Infinity, ease: "linear" },
            y: { duration: s.duration, repeat: Infinity, ease: "easeInOut" },
          }}
        >
          <s.Shape size={s.size} strokeWidth={2.5} fill={s.color} fillOpacity={0.3} />
        </motion.div>
      ))}
    </div>
  );
}
