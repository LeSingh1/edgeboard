"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { LayoutGrid, Settings as SettingsIcon, Sliders, Sparkles, FlaskConical } from "lucide-react";
import { useSelectionStore } from "@/stores/selectionStore";
import { cn } from "@/lib/cn";

const ROUTES = [
  { href: "/live-board", label: "Live Board", icon: LayoutGrid },
  { href: "/optimizer", label: "Optimizer", icon: Sliders },
  { href: "/slips", label: "Slips", icon: Sparkles },
  { href: "/model-lab", label: "Model Lab", icon: FlaskConical },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

export function TopNav() {
  const pathname = usePathname();
  const picks = useSelectionStore((s) => s.picks);
  const setBenchOpen = useSelectionStore((s) => s.setBenchOpen);

  return (
    <header className="sticky top-0 z-40 backdrop-blur-md bg-[#0D0D1A]/80 border-b-4 border-[#FF3AF2] relative">
      <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between gap-4">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 group">
          <motion.div
            initial={{ rotate: 0 }}
            animate={{ rotate: [0, -10, 10, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
            className="relative"
          >
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4] border-4 border-[#FFE600] flex items-center justify-center font-[family-name:var(--font-display)] text-[#0D0D1A] text-xl">
              E
            </div>
          </motion.div>
          <span className="font-[family-name:var(--font-heading)] font-black text-2xl tracking-tighter uppercase text-shadow-1">
            EdgeBoard
          </span>
        </Link>

        {/* Routes */}
        <nav className="hidden md:flex items-center gap-1">
          {ROUTES.map((r) => {
            const active = pathname === r.href || (r.href !== "/" && pathname.startsWith(r.href));
            const Icon = r.icon;
            return (
              <Link
                key={r.href}
                href={r.href}
                className={cn(
                  "relative px-4 py-2 rounded-full font-[family-name:var(--font-heading)] font-bold text-sm uppercase tracking-wider transition-all duration-200",
                  "flex items-center gap-2",
                  active
                    ? "text-[#0D0D1A] bg-[#FFE600]"
                    : "text-white hover:text-[#FFE600] hover:bg-white/5",
                )}
              >
                <Icon size={16} strokeWidth={3} />
                {r.label}
                {active && (
                  <motion.div
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-full ring-2 ring-[#FF3AF2] ring-offset-2 ring-offset-[#0D0D1A]"
                    transition={{ type: "spring", duration: 0.5 }}
                  />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Bench button */}
        <button
          onClick={() => setBenchOpen(true)}
          className={cn(
            "relative px-4 py-2 rounded-full border-4 font-[family-name:var(--font-heading)] font-black uppercase text-sm tracking-wider transition-all duration-200",
            picks.length > 0
              ? "bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4] border-[#FFE600] text-white animate-(--animate-pulse-glow)"
              : "border-[#FF3AF2] text-white hover:bg-[#FF3AF2]/10",
          )}
        >
          Bench ({picks.length})
        </button>
      </div>
    </header>
  );
}
