"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";
import { Bookmark, ClipboardPaste, ExternalLink, Check, AlertTriangle } from "lucide-react";

/**
 * Manual board-seeding panel — shown when /api/props can't reach PrizePicks
 * because their PerimeterX bot protection is blocking our server-side fetch.
 *
 * Three workflows, in increasing order of friction:
 *
 *   1. **Bookmarklet** — user drags a small JS payload into their bookmarks
 *      bar, then on app.prizepicks.com clicks it. The bookmarklet fetches
 *      the projections endpoint (using the browser's PX-cleared cookies)
 *      and POSTs the result to localhost:3000/api/props. One click to
 *      refresh from then on. CORS is wired on the POST endpoint so cross-
 *      origin POSTs from app.prizepicks.com succeed.
 *
 *   2. **Open + paste** — user opens the projections URL directly in a tab,
 *      copies the raw JSON, pastes it into the textarea, hits Seed. Slower
 *      but doesn't require installing a bookmarklet.
 *
 *   3. **Terminal curl** — for power users. Not surfaced in the UI; the
 *      route docstring covers it.
 */
const PROJECTIONS_URL =
  "https://api.prizepicks.com/projections?per_page=1000&include=new_player,league,stat_type,game&single_stat=true";

// The bookmarklet source. javascript: prefix + URL-encoded body. Note we
// inline the localhost target — the user can edit the bookmark URL if
// they run the app on a different port.
const BOOKMARKLET = (origin: string) =>
  `javascript:(async()=>{try{const r=await fetch(${JSON.stringify(PROJECTIONS_URL)},{credentials:'include'});if(!r.ok){alert('PrizePicks returned '+r.status);return}const j=await r.json();const s=await fetch(${JSON.stringify(origin)}+'/api/props',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(j)});const m=await s.json();alert('EdgeBoard seeded: '+(m.total||0)+' props · '+(m.leagues||[]).join(', '))}catch(e){alert('Seed failed: '+e.message)}})();`;

export function SeedBoardPanel({
  open,
  onClose,
  onSeeded,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after a successful seed so the parent can re-fetch /api/props. */
  onSeeded: () => void;
}) {
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Origin we tell the bookmarklet to POST to. Computed at render time so
  // it follows the user's actual port if they're running on something
  // other than :3000.
  const origin = typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;
  const bookmarkletHref = BOOKMARKLET(origin);

  const submitPaste = async () => {
    if (!paste.trim()) {
      setResult({ ok: false, message: "Paste the PrizePicks JSON first." });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      // Tolerate either raw JSON or the user accidentally including the
      // wrapping curly-brace + commentary by trying both shapes.
      let parsed: unknown;
      try {
        parsed = JSON.parse(paste);
      } catch {
        setResult({ ok: false, message: "That doesn't look like valid JSON. Did you copy the whole response?" });
        setBusy(false);
        return;
      }
      const res = await fetch("/api/props", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setResult({ ok: false, message: body.error || `Seed failed (${res.status})` });
        setBusy(false);
        return;
      }
      setResult({ ok: true, message: body.message || `Seeded ${body.total} props.` });
      onSeeded();
    } catch (err) {
      setResult({ ok: false, message: String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/80 backdrop-blur-sm"
            aria-hidden
          />
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", damping: 26 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="seed-title"
            className="fixed inset-0 z-50 overflow-y-auto p-4 md:p-8 flex items-start justify-center pointer-events-none"
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="pointer-events-auto w-full max-w-3xl my-8 rounded-3xl border-4 border-[#FFE600] bg-[#0D0D1A] p-6 md:p-8"
            >
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-[#FFE600]/15 border-2 border-[#FFE600] flex items-center justify-center flex-shrink-0">
                  <AlertTriangle size={20} strokeWidth={3} className="text-[#FFE600]" aria-hidden />
                </div>
                <div className="flex-1">
                  <h2 id="seed-title" className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-2xl md:text-3xl text-white leading-none">
                    Seed the board
                  </h2>
                  <p className="text-white/65 text-sm mt-2">
                    PrizePicks blocks server-side fetches from your dev box with bot protection.
                    Your <span className="text-[#FFE600] font-bold">browser</span> isn&apos;t blocked
                    though — let it pull the data, then send it here. Two ways:
                  </p>
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="text-white/50 hover:text-white text-2xl leading-none px-2"
                >
                  ×
                </button>
              </div>

              {/* ── Option 1: bookmarklet ── */}
              <section className="mt-6 rounded-2xl border-2 border-[#4ADE80]/50 bg-[#4ADE80]/5 p-4 md:p-5">
                <div className="flex items-center gap-2 mb-2">
                  <Bookmark size={16} strokeWidth={3} className="text-[#4ADE80]" aria-hidden />
                  <h3 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-sm text-[#4ADE80]">
                    Option 1 · Bookmarklet (one-click forever)
                  </h3>
                </div>
                <ol className="text-white/75 text-sm leading-relaxed list-decimal list-inside space-y-1.5">
                  <li>Drag this button to your browser&apos;s bookmarks bar:</li>
                </ol>
                <div className="mt-3 flex items-center gap-3 flex-wrap">
                  <a
                    href={bookmarkletHref}
                    onClick={(e) => e.preventDefault()}
                    draggable
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full border-4 border-[#4ADE80] bg-[#4ADE80] text-[#0D0D1A] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-sm cursor-grab active:cursor-grabbing select-none"
                    title="Drag me to your bookmarks bar"
                  >
                    <Bookmark size={14} strokeWidth={3} aria-hidden />
                    Seed EdgeBoard
                  </a>
                  <span className="text-white/40 text-xs italic">← drag this to your bookmarks bar</span>
                </div>
                <ol className="text-white/75 text-sm leading-relaxed list-decimal list-inside space-y-1.5 mt-3" start={2}>
                  <li>
                    Open{" "}
                    <a
                      href="https://app.prizepicks.com/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#00F5D4] underline inline-flex items-center gap-1"
                    >
                      app.prizepicks.com <ExternalLink size={12} strokeWidth={3} aria-hidden />
                    </a>{" "}
                    in a tab — you&apos;re already logged in there.
                  </li>
                  <li>Click the &quot;Seed EdgeBoard&quot; bookmark. You&apos;ll see an alert with the prop count.</li>
                  <li>Come back here and refresh.</li>
                </ol>
              </section>

              {/* ── Option 2: paste ── */}
              <section className="mt-5 rounded-2xl border-2 border-[#00F5D4]/50 bg-[#00F5D4]/5 p-4 md:p-5">
                <div className="flex items-center gap-2 mb-2">
                  <ClipboardPaste size={16} strokeWidth={3} className="text-[#00F5D4]" aria-hidden />
                  <h3 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-sm text-[#00F5D4]">
                    Option 2 · Paste the JSON
                  </h3>
                </div>
                <ol className="text-white/75 text-sm leading-relaxed list-decimal list-inside space-y-1.5">
                  <li>
                    Open{" "}
                    <a
                      href={PROJECTIONS_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#00F5D4] underline inline-flex items-center gap-1"
                    >
                      this URL <ExternalLink size={12} strokeWidth={3} aria-hidden />
                    </a>
                    {" "}in a new tab — you&apos;ll see raw JSON.
                  </li>
                  <li>Select all (⌘A / Ctrl-A) → copy (⌘C / Ctrl-C).</li>
                  <li>Paste it below and hit Seed.</li>
                </ol>
                <textarea
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  placeholder='Paste the full JSON response (starts with `{"data":[...`)'
                  rows={4}
                  spellCheck={false}
                  className="mt-3 w-full rounded-xl border-2 border-white/15 bg-[#0D0D1A] p-3 font-mono text-xs text-white/85 placeholder:text-white/30 focus:outline-none focus:border-[#00F5D4] resize-y"
                />
                <div className="mt-3 flex items-center gap-3 flex-wrap">
                  <button
                    onClick={submitPaste}
                    disabled={busy || !paste.trim()}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border-4 border-[#00F5D4] bg-[#00F5D4] text-[#0D0D1A] font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-sm hover:scale-[1.02] active:scale-[0.98] transition-transform disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {busy ? "Seeding…" : "Seed"}
                  </button>
                  {paste && (
                    <button
                      onClick={() => {
                        setPaste("");
                        setResult(null);
                      }}
                      className="text-white/45 text-xs uppercase tracking-widest font-bold hover:text-white"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </section>

              {/* ── Result banner ── */}
              {result && (
                <div
                  role="status"
                  className={`mt-5 flex items-start gap-2 rounded-xl border-2 p-3 ${
                    result.ok
                      ? "border-[#4ADE80] bg-[#4ADE80]/10 text-[#4ADE80]"
                      : "border-[#F87171] bg-[#F87171]/10 text-[#F87171]"
                  }`}
                >
                  {result.ok ? (
                    <Check size={16} strokeWidth={3} className="flex-shrink-0 mt-0.5" aria-hidden />
                  ) : (
                    <AlertTriangle size={16} strokeWidth={3} className="flex-shrink-0 mt-0.5" aria-hidden />
                  )}
                  <div className="text-sm font-bold">{result.message}</div>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
