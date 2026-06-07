"use client";

/**
 * EDGE-CORE - a JARVIS-style holographic readout of the live projection model.
 * Every number is pulled from /api/model-core (the real training pipeline's
 * outputs) and the panel re-polls every 15s, so as the nightly self-retrain
 * finishes each sport the core updates with its fresh metrics. Pure framer-motion +
 * SVG; no 3D deps.
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Database, Flame, Target, Scale, Shield, Divide, Cpu, Activity,
  Brain, Radio, CircleCheck, Gauge, Layers, ListChecks, Server, FileText, Download, Crosshair,
} from "lucide-react";

// ── Types (mirror /api/model-core) ──────────────────────────────────────────
interface Sport {
  key: string; name: string; verdict: string; healthy: boolean; ageHours: number;
  lastTrained: string | null; version: string; sampleSize: number; trainSamples: number;
  testN: number; accuracy: number | null; brier: number | null; logLoss: number;
  baseline: number; lift: number; liftPct: number;
}
interface Core {
  callsign: string; generatedAt: string; online: boolean;
  totals: { sports: number; healthy: number; totalSamples: number; trainSamples: number; avgAccuracy: number; avgLiftPct: number; modelVersion: string; checkedAt: string | null };
  live: { running: boolean; sport: string | null; phase: string | null; progressPct: number | null; lastUpdate: string | null };
  memory: { newestTrained: string | null; retrainCadence: string; todaysMode: string; runHistoryCount: number };
  sports: Sport[];
  traits: { key: string; name: string; blurb: string; icon: string }[];
  projectionSignals: { name: string; detail: string }[];
  dataSources: { name: string; kind: string; detail: string }[];
  gradingCriteria: { name: string; role: string; detail: string }[];
}

const TRAIT_ICONS: Record<string, typeof Database> = {
  database: Database, flame: Flame, target: Target, scale: Scale, shield: Shield, divide: Divide,
};

const C = "#27E6FF"; // core cyan

// ── helpers ──────────────────────────────────────────────────────────────────
function fmtCompact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}
function ago(iso: string | null): string {
  if (!iso) return "-";
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)}m ago`;
  if (h < 48) return `${h.toFixed(1)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** rAF counter that always lands exactly on `value`. */
function useCount(value: number, ms = 1100): number {
  const [v, setV] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      setV(from + (value - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else { setV(value); fromRef.current = value; }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return v;
}

function Stat({ label, value, sub, accent = C }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="relative">
      <div className="text-[9px] uppercase tracking-[0.2em] text-white/40 font-bold">{label}</div>
      <div className="font-[family-name:var(--font-display)] text-3xl leading-none mt-1" style={{ color: accent, textShadow: `0 0 18px ${accent}55` }}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-white/45 mt-1 font-mono">{sub}</div>}
    </div>
  );
}

// ── The reactor core (rotating rings + cognition gauge) ──────────────────────
function Reactor({ accuracy, live, lift }: { accuracy: number; live: boolean; lift: number }) {
  const pct = useCount(accuracy * 100, 1400);
  const spin = (dur: number, dir = 1) => ({
    animate: { rotate: 360 * dir },
    transition: { duration: dur, repeat: Infinity, ease: "linear" as const },
    style: { transformBox: "fill-box" as const, transformOrigin: "center" },
  });
  const ticks = Array.from({ length: 60 });
  return (
    <div className="relative w-[360px] h-[360px] mx-auto">
      {/* pulsing aura */}
      <motion.div
        className="absolute inset-6 rounded-full"
        style={{ background: `radial-gradient(circle, ${C}22 0%, transparent 65%)` }}
        animate={{ opacity: live ? [0.4, 0.9, 0.4] : [0.25, 0.5, 0.25], scale: [0.96, 1.04, 0.96] }}
        transition={{ duration: live ? 1.8 : 3.4, repeat: Infinity, ease: "easeInOut" }}
      />
      <svg viewBox="0 0 360 360" className="absolute inset-0 w-full h-full">
        <defs>
          <linearGradient id="arc" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={C} /><stop offset="100%" stopColor="#3B82F6" />
          </linearGradient>
        </defs>
        {/* outer tick ring (slow) */}
        <motion.g {...spin(64)}>
          {ticks.map((_, i) => {
            const a = (i / 60) * Math.PI * 2;
            const r1 = 174, r2 = i % 5 === 0 ? 162 : 168;
            return <line key={i} x1={180 + r1 * Math.cos(a)} y1={180 + r1 * Math.sin(a)} x2={180 + r2 * Math.cos(a)} y2={180 + r2 * Math.sin(a)} stroke={C} strokeWidth={i % 5 === 0 ? 1.6 : 0.7} opacity={0.5} />;
          })}
        </motion.g>
        {/* dashed mid ring (reverse) */}
        <motion.circle cx="180" cy="180" r="132" fill="none" stroke={C} strokeOpacity="0.35" strokeWidth="1" strokeDasharray="2 10" {...spin(38, -1)} />
        {/* segmented arc ring */}
        <motion.circle cx="180" cy="180" r="118" fill="none" stroke="#3B82F6" strokeOpacity="0.6" strokeWidth="2" strokeDasharray="40 22" {...spin(26)} />
        {/* cognition gauge track */}
        <circle cx="180" cy="180" r="100" fill="none" stroke="#ffffff" strokeOpacity="0.06" strokeWidth="10" />
        <motion.circle
          cx="180" cy="180" r="100" fill="none" stroke="url(#arc)" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={2 * Math.PI * 100}
          initial={{ strokeDashoffset: 2 * Math.PI * 100 }}
          animate={{ strokeDashoffset: 2 * Math.PI * 100 * (1 - accuracy) }}
          transition={{ duration: 1.6, ease: [0.22, 1, 0.36, 1] }}
          style={{ transform: "rotate(-90deg)", transformOrigin: "center", filter: `drop-shadow(0 0 6px ${C})` }}
        />
        {/* inner spinning crosshair */}
        <motion.g {...spin(18, -1)} opacity={0.5}>
          <line x1="180" y1="92" x2="180" y2="104" stroke={C} strokeWidth="2" />
          <line x1="180" y1="256" x2="180" y2="268" stroke={C} strokeWidth="2" />
          <line x1="92" y1="180" x2="104" y2="180" stroke={C} strokeWidth="2" />
          <line x1="256" y1="180" x2="268" y2="180" stroke={C} strokeWidth="2" />
        </motion.g>
      </svg>
      {/* center readout */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <motion.div animate={{ scale: live ? [1, 1.06, 1] : 1 }} transition={{ duration: 1.8, repeat: Infinity }}>
          <Brain size={26} style={{ color: C }} className="mx-auto mb-1" strokeWidth={2.2} />
        </motion.div>
        <div className="font-[family-name:var(--font-display)] text-6xl leading-none" style={{ color: "#fff", textShadow: `0 0 28px ${C}` }}>
          {pct.toFixed(1)}<span className="text-2xl" style={{ color: C }}>%</span>
        </div>
        <div className="text-[10px] uppercase tracking-[0.35em] text-white/50 font-bold mt-1">Cognition</div>
        <div className="text-[10px] font-mono mt-1.5" style={{ color: "#4ADE80" }}>+{(lift * 100).toFixed(1)}% vs baseline</div>
      </div>
    </div>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────
function Panel({ title, icon: Icon, children, delay = 0 }: { title: string; icon: typeof Cpu; children: React.ReactNode; delay?: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay, duration: 0.5 }}
      className="relative rounded-2xl border p-4" style={{ borderColor: `${C}26`, background: "rgba(10,18,30,0.5)", backdropFilter: "blur(6px)" }}>
      {["top-1.5 left-1.5 border-t border-l", "top-1.5 right-1.5 border-t border-r", "bottom-1.5 left-1.5 border-b border-l", "bottom-1.5 right-1.5 border-b border-r"].map((c) => (
        <span key={c} className={`absolute w-2.5 h-2.5 ${c}`} style={{ borderColor: C }} />
      ))}
      <div className="flex items-center gap-2 mb-3">
        <Icon size={13} style={{ color: C }} />
        <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-[0.2em] text-[11px] text-white/75">{title}</span>
      </div>
      {children}
    </motion.div>
  );
}

function SportRow({ s, i, max }: { s: Sport; i: number; max: number }) {
  void max;
  const acc = (s.accuracy ?? 0) * 100;
  return (
    <motion.div initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 + i * 0.04 }}
      className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.healthy ? "#4ADE80" : "#FFB020" }} />
          <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-xs text-white">{s.name}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono text-white/40">{fmtCompact(s.sampleSize)}</span>
          <span className="font-[family-name:var(--font-display)] text-sm" style={{ color: C }}>{acc.toFixed(1)}%</span>
        </div>
      </div>
      <div className="mt-1.5 h-1 rounded bg-white/8 overflow-hidden">
        <motion.div className="h-full rounded" style={{ background: `linear-gradient(90deg, #3B82F6, ${C})` }}
          initial={{ width: 0 }} animate={{ width: `${acc}%` }} transition={{ delay: 0.4 + i * 0.04, duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
      </div>
      <div className="flex items-center justify-between mt-1 text-[9px] font-mono text-white/35">
        <span>+{(s.liftPct * 100).toFixed(1)}% edge · brier {s.brier?.toFixed(3) ?? "-"}</span>
        <span style={{ color: s.healthy ? undefined : "#FFB020" }}>{s.verdict} · {ago(s.lastTrained)}</span>
      </div>
    </motion.div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ModelCorePage() {
  const [core, setCore] = useState<Core | null>(null);
  const [booted, setBooted] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/model-core").then((r) => r.json()).then((d) => { if (alive) { setCore(d); setErr(false); } }).catch(() => alive && setErr(true));
    load();
    const id = setInterval(load, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  useEffect(() => { const t = setTimeout(() => setBooted(true), 1500); return () => clearTimeout(t); }, []);

  const samples = useCount(core?.totals.totalSamples ?? 0, 1600);
  const maxSample = core ? Math.max(...core.sports.map((s) => s.sampleSize)) : 1;

  // Build a full plain-text report from the live telemetry and download it.
  // Everything in it is real (read from the trained artifacts), nothing invented.
  function downloadReport() {
    if (!core) return;
    const t = core.totals;
    const L = [];
    L.push("EDGE-CORE MODEL REPORT");
    L.push("generated " + new Date(core.generatedAt).toISOString());
    L.push("");
    L.push("OVERVIEW");
    L.push(`  model            ${t.modelVersion}`);
    L.push(`  leagues          ${t.sports} (${t.healthy} healthy)`);
    L.push(`  training rows    ${t.totalSamples.toLocaleString()}`);
    L.push(`  weighted acc     ${(t.avgAccuracy * 100).toFixed(1)}%`);
    L.push(`  edge vs baseline +${(t.avgLiftPct * 100).toFixed(1)}%`);
    L.push(`  retrain cadence  daily (today is a ${core.memory.todaysMode} day)`);
    L.push(`  last retrain     ${core.memory.newestTrained ?? "unknown"}`);
    L.push(`  live now         ${core.live.running ? `${core.live.sport?.toUpperCase()} ${core.live.phase} ${(((core.live.progressPct ?? 0)) * 100).toFixed(0)}%` : "idle"}`);
    L.push("");
    L.push("PER-SPORT RESULTS (held-out test split)");
    L.push("  sport    acc     brier  logloss  baseline  lift     samples       status");
    for (const s of core.sports) {
      L.push(`  ${(s.name).padEnd(7)}  ${((s.accuracy ?? 0) * 100).toFixed(1)}%  ${(s.brier ?? 0).toFixed(3)}  ${s.logLoss.toFixed(3)}    ${s.baseline.toFixed(3)}     +${(s.liftPct * 100).toFixed(1)}%`.padEnd(58) + `${s.sampleSize.toLocaleString().padStart(12)}  ${s.verdict}`);
    }
    L.push("");
    L.push("PROJECTION SIGNALS (context applied before the probability)");
    for (const ps of core.projectionSignals) L.push(`  - ${ps.name}: ${ps.detail}`);
    L.push("");
    L.push("HOW PICKS ARE GRADED");
    for (const c of core.gradingCriteria) L.push(`  - ${c.name} (${c.role}): ${c.detail}`);
    L.push("");
    L.push("DATA SOURCES");
    for (const d of core.dataSources) L.push(`  - ${d.name} (${d.kind}): ${d.detail}`);
    L.push("");
    L.push("COGNITIVE TRAITS (decision layers)");
    for (const tr of core.traits) L.push(`  - ${tr.name}: ${tr.blurb}`);
    L.push("");
    L.push("Not financial advice. Sports betting has a built-in house edge and most people lose.");
    const blob = new Blob([L.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `edge-core-report-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="relative min-h-screen overflow-hidden" style={{ background: "#03070E" }}>
      {/* ambient grid + glow */}
      <div className="pointer-events-none absolute inset-0" style={{
        backgroundImage: `linear-gradient(${C}0a 1px, transparent 1px), linear-gradient(90deg, ${C}0a 1px, transparent 1px)`,
        backgroundSize: "44px 44px", maskImage: "radial-gradient(circle at 50% 38%, black, transparent 78%)", WebkitMaskImage: "radial-gradient(circle at 50% 38%, black, transparent 78%)",
      }} />
      <div className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(circle at 50% 30%, ${C}12 0%, transparent 60%)` }} />

      {/* boot overlay */}
      <AnimatePresence>
        {!booted && (
          <motion.div className="absolute inset-0 z-50 flex flex-col items-center justify-center" style={{ background: "#03070E" }}
            exit={{ opacity: 0 }} transition={{ duration: 0.6 }}>
            <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.5 }}>
              <Cpu size={46} style={{ color: C }} className="animate-pulse" />
            </motion.div>
            <div className="mt-5 font-mono text-xs tracking-[0.4em] uppercase" style={{ color: C }}>Initializing Edge-Core</div>
            <div className="mt-3 w-52 h-0.5 bg-white/10 overflow-hidden rounded">
              <motion.div className="h-full" style={{ background: C }} initial={{ width: "0%" }} animate={{ width: "100%" }} transition={{ duration: 1.3, ease: "easeInOut" }} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative z-10 max-w-7xl mx-auto px-4 md:px-8 py-6">
        {/* top status bar */}
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between flex-wrap gap-3 border-b border-white/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ border: `1.5px solid ${C}`, boxShadow: `0 0 18px ${C}55, inset 0 0 12px ${C}33` }}>
              <Cpu size={20} style={{ color: C }} />
            </div>
            <div>
              <div className="font-[family-name:var(--font-heading)] font-black tracking-[0.3em] text-lg" style={{ color: "#fff" }}>
                EDGE<span style={{ color: C }}>·</span>CORE
              </div>
              <div className="text-[10px] text-white/45 font-mono">{core?.totals.modelVersion ?? "…"} · retrains daily · re-calibrates</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={downloadReport}
              disabled={!core}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg border text-xs font-bold uppercase tracking-widest transition-colors disabled:opacity-40"
              style={{ borderColor: `${C}55`, color: C, background: `${C}12` }}
            >
              <FileText size={13} strokeWidth={2.5} />
              Generate report
              <Download size={12} strokeWidth={2.5} className="opacity-70" />
            </button>
            <div className="flex items-center gap-2">
              <motion.span className="w-2 h-2 rounded-full" style={{ background: core?.online ? "#4ADE80" : "#F87171" }}
                animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.6, repeat: Infinity }} />
              <span className="text-xs font-mono uppercase tracking-widest" style={{ color: core?.online ? "#4ADE80" : "#F87171" }}>
                {err ? "link lost" : core?.online ? "online" : "booting"}
              </span>
            </div>
          </div>
        </motion.div>

        {/* main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px_1fr] gap-6 mt-6 items-start">
          {/* LEFT - memory + totals */}
          <div className="space-y-5">
            <Panel title="Daily Retraining" icon={Radio} delay={0.1}>
              <div className="flex items-center justify-between">
                <div className="text-xs text-white/55">Retrain cadence</div>
                <div className="text-xs font-mono" style={{ color: C }}>EVERY 24H</div>
              </div>
              <div className="flex items-center justify-between mt-2">
                <div className="text-xs text-white/55">Today&apos;s cycle</div>
                <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded"
                  style={{ color: "#03070E", background: core?.memory.todaysMode === "train" ? C : "#FFB020" }}>
                  {core?.memory.todaysMode === "train" ? "Train day" : "Test day"}
                </span>
              </div>
              <div className="flex items-center justify-between mt-2">
                <div className="text-xs text-white/55">Last retrain</div>
                <div className="text-xs font-mono text-white/80">{ago(core?.memory.newestTrained ?? null)}</div>
              </div>
              <p className="text-[11px] text-white/45 leading-relaxed mt-3 border-t border-white/10 pt-3">
                On even days it trains on the day&apos;s games; on odd days it holds them out as a live test and grades itself. Each run keeps the model current and re-calibrated. It does not keep getting smarter without limit, accuracy is near its ceiling.
              </p>
            </Panel>

            <Panel title="Live Cognition" icon={Activity} delay={0.18}>
              {core?.live.running ? (
                <div>
                  <div className="flex items-center gap-2">
                    <motion.span className="w-2 h-2 rounded-full" style={{ background: C }} animate={{ scale: [1, 1.6, 1], opacity: [1, 0.4, 1] }} transition={{ duration: 1, repeat: Infinity }} />
                    <span className="text-sm font-bold uppercase tracking-wider" style={{ color: C }}>Learning now</span>
                  </div>
                  <div className="text-xs text-white/60 mt-2 font-mono">
                    {core.live.sport?.toUpperCase()} · {core.live.phase}
                  </div>
                  <div className="mt-2 h-1.5 bg-white/10 rounded overflow-hidden">
                    <motion.div className="h-full" style={{ background: `linear-gradient(90deg, #3B82F6, ${C})` }}
                      animate={{ width: `${Math.round((core.live.progressPct ?? 0) * 100)}%` }} transition={{ duration: 0.8 }} />
                  </div>
                  <div className="text-[10px] text-white/40 mt-1 font-mono text-right">{Math.round((core.live.progressPct ?? 0) * 100)}%</div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-white/50 text-sm">
                  <CircleCheck size={15} style={{ color: "#4ADE80" }} /> Idle. Models deployed and healthy
                </div>
              )}
            </Panel>

            <div className="grid grid-cols-2 gap-4 px-1">
              <Stat label="Total data" value={fmtCompact(samples)} sub="box-score samples" />
              <Stat label="Sports online" value={`${core?.totals.healthy ?? 0}/${core?.totals.sports ?? 0}`} sub="leagues modeled" accent="#4ADE80" />
              <Stat label="Train rows" value={fmtCompact(core?.totals.trainSamples ?? 0)} sub="fit to history" />
              <Stat label="Edge" value={`+${((core?.totals.avgLiftPct ?? 0) * 100).toFixed(1)}%`} sub="over baseline" accent="#FFB020" />
            </div>
          </div>

          {/* CENTER - reactor */}
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.2, duration: 0.6 }}>
            {core && <Reactor accuracy={core.totals.avgAccuracy} live={core.live.running} lift={core.totals.avgLiftPct} />}
            <div className="text-center mt-2 font-mono text-[10px] text-white/40 tracking-widest">
              {core ? `${core.totals.sports} LEAGUES · ${fmtCompact(core.totals.totalSamples)} SAMPLES · ${core.totals.modelVersion}` : "…"}
            </div>
          </motion.div>

          {/* RIGHT - sport matrix */}
          <Panel title="Sport Matrix" icon={Layers} delay={0.26}>
            <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
              {core?.sports.map((s, i) => (
                <SportRow key={s.key} s={s} i={i} max={maxSample} />
              ))}
            </div>
          </Panel>
        </div>

        {/* COGNITIVE TRAITS */}
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-3">
            <Gauge size={15} style={{ color: C }} />
            <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-[0.3em] text-sm text-white/80">Cognitive Traits</h2>
            <div className="flex-1 h-px bg-white/10" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {core?.traits.map((t, i) => {
              const Icon = TRAIT_ICONS[t.icon] ?? Cpu;
              return (
                <motion.div key={t.key} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 + i * 0.07 }}
                  className="relative rounded-xl border p-4 overflow-hidden"
                  style={{ borderColor: `${C}33`, background: `linear-gradient(180deg, ${C}0d, transparent)` }}>
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ border: `1px solid ${C}55`, color: C, boxShadow: `inset 0 0 10px ${C}22` }}>
                      <Icon size={15} strokeWidth={2.2} />
                    </div>
                    <div className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-xs text-white">{t.name}</div>
                  </div>
                  <p className="text-[11px] text-white/50 leading-relaxed mt-2">{t.blurb}</p>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* PROJECTION SIGNALS */}
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-1">
            <Crosshair size={15} style={{ color: C }} />
            <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-[0.3em] text-sm text-white/80">Projection signals</h2>
            <div className="flex-1 h-px bg-white/10" />
          </div>
          <p className="text-[11px] text-white/40 mb-3 max-w-3xl">
            Context the model layers onto a player&apos;s baseline before it ever computes a probability. Not all of these fire on every pick (each needs enough data), and the richest context lands on NBA and WNBA.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {core?.projectionSignals.map((ps, i) => (
              <motion.div key={ps.name} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 + i * 0.04 }}
                className="rounded-xl border p-3.5" style={{ borderColor: `${C}22`, background: "rgba(10,18,30,0.4)" }}>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: C }} />
                  <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-[11px] text-white">{ps.name}</span>
                </div>
                <p className="text-[11px] text-white/55 leading-relaxed mt-1.5">{ps.detail}</p>
              </motion.div>
            ))}
          </div>
        </div>

        {/* HOW PICKS ARE GRADED */}
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-3">
            <ListChecks size={15} style={{ color: C }} />
            <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-[0.3em] text-sm text-white/80">How picks are graded</h2>
            <div className="flex-1 h-px bg-white/10" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {core?.gradingCriteria.map((c, i) => (
              <motion.div key={c.name} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 + i * 0.05 }}
                className="rounded-xl border p-4" style={{ borderColor: `${C}26`, background: "rgba(10,18,30,0.4)" }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-xs text-white">{c.name}</span>
                  <span className="text-[9px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded" style={{ color: C, background: `${C}14` }}>{c.role}</span>
                </div>
                <p className="text-[11px] text-white/55 leading-relaxed mt-1.5">{c.detail}</p>
              </motion.div>
            ))}
          </div>
        </div>

        {/* DATA SOURCES */}
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-3">
            <Server size={15} style={{ color: C }} />
            <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-[0.3em] text-sm text-white/80">Data sources</h2>
            <div className="flex-1 h-px bg-white/10" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {core?.dataSources.map((d, i) => (
              <motion.div key={d.name} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 + i * 0.05 }}
                className="rounded-xl border p-4 flex flex-col" style={{ borderColor: `${C}26`, background: "rgba(10,18,30,0.4)" }}>
                <div className="flex items-center gap-2">
                  <Database size={13} style={{ color: C }} />
                  <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-xs text-white">{d.name}</span>
                </div>
                <span className="text-[9px] font-mono uppercase tracking-widest text-white/40 mt-1">{d.kind}</span>
                <p className="text-[11px] text-white/55 leading-relaxed mt-1.5">{d.detail}</p>
              </motion.div>
            ))}
          </div>
        </div>

        {/* full report footer */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }}
          className="mt-8 flex items-center justify-between flex-wrap gap-3 border-t border-white/10 pt-4 font-mono text-[10px] text-white/40">
          <span>MODEL {core?.totals.modelVersion} · ISOTONIC-CALIBRATED · PUSH-AVERSE</span>
          <span>HEALTH CHECK {core?.totals.checkedAt ? ago(core.totals.checkedAt) : "-"} · {core?.totals.healthy}/{core?.totals.sports} NOMINAL</span>
          <span style={{ color: C }}>● TELEMETRY LIVE · REFRESH 15s</span>
        </motion.div>
      </div>
    </div>
  );
}
