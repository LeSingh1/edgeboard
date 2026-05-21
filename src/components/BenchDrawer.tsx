"use client";

import { AnimatePresence, motion } from "framer-motion";
import { X, Trash2, TrendingUp, TrendingDown, Sparkles } from "lucide-react";
import Link from "next/link";
import { useSelectionStore } from "@/stores/selectionStore";
import { accentHexFor, cn } from "@/lib/cn";

export function BenchDrawer() {
  const open = useSelectionStore((s) => s.benchOpen);
  const setOpen = useSelectionStore((s) => s.setBenchOpen);
  const picks = useSelectionStore((s) => s.picks);
  const remove = useSelectionStore((s) => s.remove);
  const clear = useSelectionStore((s) => s.clear);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
            onClick={() => setOpen(false)}
          />

          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 26, stiffness: 240 }}
            className="fixed top-0 right-0 bottom-0 z-50 w-full md:w-[440px] bg-[#0D0D1A] border-l-8 border-[#FFE600] flex flex-col overflow-hidden"
          >
            <div
              aria-hidden
              className="absolute inset-0 pointer-events-none opacity-30"
              style={{
                backgroundImage:
                  "radial-gradient(circle, rgba(255,58,242,0.4) 1px, transparent 1px)",
                backgroundSize: "20px 20px",
              }}
            />

            <div className="relative p-6 border-b-4 border-dashed border-[#FF3AF2] flex items-center justify-between">
              <div>
                <h2 className="font-[family-name:var(--font-display)] text-5xl text-[#FFE600] text-shadow-2 leading-none">
                  BENCH
                </h2>
                <p className="font-[family-name:var(--font-body)] text-white/70 text-sm mt-2 uppercase tracking-widest font-bold">
                  {picks.length} {picks.length === 1 ? "pick" : "picks"} locked in
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="w-12 h-12 rounded-full border-4 border-[#FF3AF2] flex items-center justify-center text-white hover:bg-[#FF3AF2] transition-all hover:rotate-90"
                aria-label="Close bench"
              >
                <X size={20} strokeWidth={3} />
              </button>
            </div>

            <div className="relative flex-1 overflow-y-auto p-6 space-y-3">
              {picks.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
                  <Sparkles size={64} className="text-[#FFE600] animate-(--animate-wiggle)" />
                  <h3 className="font-[family-name:var(--font-heading)] text-3xl font-black uppercase text-shadow-1">
                    No picks yet
                  </h3>
                  <p className="text-white/60 text-sm">
                    Click MORE or LESS on a prop to add it to your bench.
                  </p>
                </div>
              ) : (
                picks.map((pick, i) => {
                  const accent = accentHexFor(i);
                  const isMore = pick.side === "more";
                  const prob = isMore ? pick.prop.pMore : pick.prop.pLess;
                  return (
                    <motion.div
                      key={pick.propId}
                      layout
                      initial={{ opacity: 0, x: 40 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 40 }}
                      transition={{ type: "spring", damping: 20 }}
                      className="relative rounded-2xl border-4 p-3 backdrop-blur-sm bg-[#2D1B4E]/60 flex items-center gap-3"
                      style={{ borderColor: accent, boxShadow: `4px 4px 0 ${accent}` }}
                    >
                      {/* Player image or initials */}
                      <div
                        className="w-12 h-12 rounded-full border-2 overflow-hidden flex-shrink-0 bg-[#0D0D1A] flex items-center justify-center"
                        style={{ borderColor: accent }}
                      >
                        {pick.prop.playerImage ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={pick.prop.playerImage}
                            alt={pick.prop.playerName}
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span className="font-[family-name:var(--font-heading)] font-black text-xs text-white">
                            {pick.prop.playerName.slice(0, 2).toUpperCase()}
                          </span>
                        )}
                      </div>

                      <div
                        className={cn(
                          "w-9 h-9 rounded-lg border-4 flex items-center justify-center flex-shrink-0",
                          isMore ? "border-[#4ADE80] text-[#4ADE80]" : "border-[#F87171] text-[#F87171]",
                        )}
                      >
                        {isMore ? <TrendingUp size={16} strokeWidth={3} /> : <TrendingDown size={16} strokeWidth={3} />}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="font-[family-name:var(--font-heading)] font-black uppercase text-sm truncate">
                          {pick.prop.playerName}
                        </div>
                        <div className="text-white/70 text-xs">
                          {pick.prop.statType} · L{pick.prop.line}
                          {prob ? <> · {(prob * 100).toFixed(0)}%</> : null}
                        </div>
                      </div>

                      <button
                        onClick={() => remove(pick.propId)}
                        className="w-9 h-9 rounded-lg border-2 border-dashed border-white/30 text-white/60 hover:text-[#F87171] hover:border-[#F87171] transition-all flex items-center justify-center flex-shrink-0"
                        aria-label={`Remove ${pick.prop.playerName}`}
                      >
                        <Trash2 size={14} strokeWidth={2.5} />
                      </button>
                    </motion.div>
                  );
                })
              )}
            </div>

            {picks.length > 0 && (
              <div className="relative p-6 border-t-4 border-[#FF3AF2] flex flex-col gap-3 bg-[#0D0D1A]">
                <Link
                  href="/optimizer"
                  onClick={() => setOpen(false)}
                  className="relative h-14 rounded-full border-4 border-[#FFE600] bg-gradient-to-r from-[#FF3AF2] via-[#7B2FFF] to-[#00F5D4] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-white flex items-center justify-center hover:scale-105 active:scale-95 transition-transform shadow-[4px_4px_0_#FFE600,8px_8px_0_#00F5D4]"
                >
                  Optimize · {picks.length} picks →
                </Link>
                <button
                  onClick={clear}
                  className="text-white/50 hover:text-[#F87171] text-xs uppercase tracking-widest font-bold transition-colors py-2"
                >
                  Clear bench
                </button>
              </div>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
