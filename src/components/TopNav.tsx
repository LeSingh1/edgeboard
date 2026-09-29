"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { LayoutGrid, Settings as SettingsIcon, Sliders, Sparkles, FlaskConical, Trophy, Cpu, Scale } from "lucide-react";
import { useSelectionStore } from "@/stores/selectionStore";
import { cn } from "@/lib/cn";

const ROUTES = [
  { href: "/live-board", label: "Live Board", icon: LayoutGrid },
  { href: "/auto-pilot", label: "Auto-Pilot", icon: Trophy },
  { href: "/line-betting", label: "Line Betting", icon: Scale },
  { href: "/optimizer", label: "Optimizer", icon: Sliders },
  { href: "/slips", label: "Slips", icon: Sparkles },
  { href: "/model-lab", label: "Model Lab", icon: FlaskConical },
  { href: "/model-core", label: "Model Core", icon: Cpu },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

export function TopNav() {
  const pathname = usePathname();
  const picks = useSelectionStore((s) => s.picks);
  const setBenchOpen = useSelectionStore((s) => s.setBenchOpen);

  return (
    <header className="sticky top-0 z-40 backdrop-blur-md bg-[#0D0D1A]/80 border-b-4 border-[#FF3AF2] relative">
      <div className="max-w-7xl 2xl:max-w-[1500px] mx-auto px-6 py-3 flex items-center justify-between gap-4">
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
          <span className="font-[family-name:var(--font-heading)] font-black text-2xl tracking-tighter uppercase text-shadow-1 xl:hidden 2xl:inline">
            EdgeBoard
          </span>
        </Link>

        {/* Routes */}
        <nav className="hidden md:flex items-center gap-0.5">
          {ROUTES.map((r) => {
            const active = pathname === r.href || (r.href !== "/" && pathname.startsWith(r.href));
            const Icon = r.icon;
            return (
              <Link
                key={r.href}
                href={r.href}
                title={r.label}
                className={cn(
                  "relative px-2.5 py-2 rounded-full font-[family-name:var(--font-heading)] font-bold text-xs uppercase tracking-wide whitespace-nowrap transition-all duration-200",
                  "flex items-center gap-1.5",
                  active
                    ? "text-[#0D0D1A] bg-[#FFE600]"
                    : "text-white hover:text-[#FFE600] hover:bg-white/5",
                )}
              >
                <Icon size={16} strokeWidth={3} />
                {/* 8 tabs: icon-only on md/lg (hover for the name), labels from xl up. On xl the
                    wordmark hides (logo badge stays) so the Bench button never gets pushed off-screen. */}
                <span className="hidden xl:inline">{r.label}</span>
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
            "relative shrink-0 whitespace-nowrap px-4 py-2 rounded-full border-4 font-[family-name:var(--font-heading)] font-black uppercase text-sm tracking-wider transition-all duration-200",
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
