"use client";

import { motion } from "framer-motion";
import { AlertTriangle, Key, Clock, Trophy, Check, Activity, Eye, EyeOff, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useBankrollStore, bankrollSummary } from "@/stores/bankrollStore";
import { useProjectionStore } from "@/stores/projectionStore";

function maskKey(k: string) {
  if (!k) return "";
  if (k.length <= 8) return `…${k.slice(-3)}`;
  return `…${k.slice(-6)}`;
}

export default function SettingsPage() {
  const anthropicKey = useSettingsStore((s) => s.anthropicKey);
  const setAnthropicKey = useSettingsStore((s) => s.setAnthropicKey);
  const polling = useSettingsStore((s) => s.pollingMinutes);
  const setPolling = useSettingsStore((s) => s.setPolling);
  const resetSettings = useSettingsStore((s) => s.reset);

  const records = useBankrollStore((s) => s.records);
  const resetBankroll = useBankrollStore((s) => s.reset);
  const clearProjections = useProjectionStore((s) => s.clear);

  const [keyDraft, setKeyDraft] = useState(anthropicKey);
  const [revealAnthropic, setRevealAnthropic] = useState(false);
  const [anthropicJustSaved, setAnthropicJustSaved] = useState(false);

  // ── Autosave Anthropic key (debounced 600ms) ──
  useEffect(() => {
    if (keyDraft === anthropicKey) return;
    const t = setTimeout(() => {
      setAnthropicKey(keyDraft.trim());
      setAnthropicJustSaved(true);
      setTimeout(() => setAnthropicJustSaved(false), 1400);
    }, 600);
    return () => clearTimeout(t);
  }, [keyDraft, anthropicKey, setAnthropicKey]);

  const summary = bankrollSummary(records);
  void clearProjections; // kept for future use

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-8 md:py-12">
      <motion.h1
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="font-[family-name:var(--font-heading)] font-black uppercase tracking-tighter text-6xl md:text-8xl leading-none gradient-text-rainbow"
      >
        Settings
      </motion.h1>
      <p className="text-white/60 mt-3 max-w-2xl">
        Everything here saves locally to your browser. Nothing leaves your machine.
      </p>

      <div className="mt-12 space-y-6">
        {/* Anthropic key */}
        <KeyCard
          accent="#FF3AF2"
          accent2="#FFE600"
          icon={Key}
          title="Anthropic API key"
          description={
            <>
              Powers Claude vision OCR fallback + lineup explainer (future). Stored in{" "}
              <code className="text-[#00F5D4]">localStorage</code> only — never leaves your machine.
            </>
          }
          placeholder="sk-ant-..."
          draft={keyDraft}
          setDraft={setKeyDraft}
          saved={anthropicKey}
          justSaved={anthropicJustSaved}
          reveal={revealAnthropic}
          setReveal={setRevealAnthropic}
          unsavedConnectedLabel={null}
        />

        {/* Data sources — informational, no inputs */}
        <SettingCard accent="#00F5D4" accent2="#FFE600">
          <SettingHeader icon={Activity} title="Real projection data sources" accent="#00F5D4" />
          <p className="text-white/60 text-sm mb-3">
            EdgeBoard pulls each player&apos;s past games and uses them to compute the real chance of
            hitting — no API keys required. When game data isn&apos;t available, falls back to PrizePicks&apos;s
            own default chance for that line (50% standard, ~40% demon, ~59% goblin).
          </p>
          <ul className="space-y-1.5 text-sm">
            <li className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-[#4ADE80]" />
              <strong className="text-[#4ADE80] font-[family-name:var(--font-heading)] uppercase tracking-widest text-xs">MLB</strong>
              <span className="text-white/70">— MLB Stats API (statsapi.mlb.com), per-game logs</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-[#4ADE80]" />
              <strong className="text-[#4ADE80] font-[family-name:var(--font-heading)] uppercase tracking-widest text-xs">NBA</strong>
              <span className="text-white/70">— ESPN public gamelog, regular season + playoffs</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-[#4ADE80]" />
              <strong className="text-[#4ADE80] font-[family-name:var(--font-heading)] uppercase tracking-widest text-xs">WNBA</strong>
              <span className="text-white/70">— ESPN public gamelog</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-white/30" />
              <strong className="text-white/50 font-[family-name:var(--font-heading)] uppercase tracking-widest text-xs">Other sports</strong>
              <span className="text-white/50">— uses PrizePicks&apos;s default chance for that line only</span>
            </li>
          </ul>
        </SettingCard>


        {/* Polling cadence */}
        <SettingCard accent="#00F5D4" accent2="#FF3AF2">
          <SettingHeader icon={Clock} title="Polling cadence" accent="#00F5D4" />
          <p className="text-white/60 text-sm mb-4">
            How often the live board refreshes from PrizePicks. Default 5 minutes. Minimum 2 (polite to upstream).
          </p>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={2}
              max={30}
              value={polling}
              onChange={(e) => setPolling(Number(e.target.value))}
              className="flex-1 accent-[#00F5D4]"
              aria-label="Polling cadence in minutes"
            />
            <div className="font-[family-name:var(--font-display)] text-4xl text-[#00F5D4] min-w-[80px] text-right">
              {polling}m
            </div>
          </div>
        </SettingCard>

        {/* Backtest calibration */}
        <CalibrationToggleCard />

        {/* Bankroll */}
        <SettingCard accent="#FFE600" accent2="#7B2FFF">
          <SettingHeader icon={Trophy} title="Bankroll" accent="#FFE600" />
          <p className="text-white/60 text-sm mb-4">
            Tracks slips you&apos;ve marked &quot;entered&quot; on the leaderboard, and the wins / losses you record afterward.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatBox
              label="Entered"
              value={summary.enteredCount.toString()}
              accent="#FFE600"
            />
            <StatBox
              label="Resolved"
              value={summary.resolvedCount.toString()}
              accent="#00F5D4"
            />
            <StatBox
              label="Staked"
              value={`$${summary.totalStaked.toFixed(0)}`}
              accent="#FF3AF2"
            />
            <StatBox
              label="Profit"
              value={`${summary.profit >= 0 ? "+" : ""}$${summary.profit.toFixed(2)}`}
              accent={summary.profit >= 0 ? "#4ADE80" : "#F87171"}
            />
            <StatBox
              label="ROI"
              value={
                summary.totalStaked > 0
                  ? `${(summary.roi * 100).toFixed(1)}%`
                  : "—"
              }
              accent={summary.roi >= 0 ? "#4ADE80" : "#F87171"}
            />
          </div>
          <button
            onClick={() => {
              if (confirm("Clear all bankroll history? This can't be undone.")) {
                resetBankroll();
              }
            }}
            className="mt-4 px-5 py-2 rounded-full border-2 border-dashed border-[#F87171] text-[#F87171] text-xs uppercase tracking-widest font-black hover:bg-[#F87171]/10 transition-colors"
          >
            Reset bankroll
          </button>
        </SettingCard>

        {/* Compliance */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="rounded-3xl border-4 border-[#F87171] bg-gradient-to-br from-[#F87171]/15 to-[#FF6B35]/15 backdrop-blur-sm p-6 md:p-8"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl border-4 border-[#FFE600] bg-[#F87171] flex items-center justify-center">
              <AlertTriangle size={22} strokeWidth={3} className="text-[#0D0D1A]" aria-hidden />
            </div>
            <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-2xl text-[#F87171] text-shadow-1">
              Compliance notice
            </h2>
          </div>
          <p className="text-white/85 text-sm leading-relaxed">
            EdgeBoard is a personal analytics tool. It does not place entries, redistribute PrizePicks
            data, or guarantee outcomes. You are responsible for verifying lines, payouts, and contest
            eligibility before placing any entry. The PrizePicks data source is accessed through their
            public projections endpoint; this access pattern may violate their Terms of Service.{" "}
            <strong className="text-[#FFE600]">Use at your own discretion. Do not deploy this app publicly.</strong>
          </p>
          <button
            onClick={() => {
              if (confirm("Reset every saved preference? API key, polling, bankroll — all gone.")) {
                resetSettings();
                resetBankroll();
              }
            }}
            className="mt-5 px-5 py-2 rounded-full border-2 border-dashed border-white/30 text-white/60 text-xs uppercase tracking-widest font-bold hover:border-[#F87171] hover:text-[#F87171] transition-colors"
          >
            Reset all preferences
          </button>
        </motion.div>
      </div>
    </div>
  );
}

function KeyCard({
  accent,
  accent2,
  icon: Icon,
  title,
  description,
  placeholder,
  draft,
  setDraft,
  saved,
  justSaved,
  reveal,
  setReveal,
  unsavedConnectedLabel,
}: {
  accent: string;
  accent2: string;
  icon: typeof Key;
  title: string;
  description: React.ReactNode;
  placeholder: string;
  draft: string;
  setDraft: (v: string) => void;
  saved: string;
  justSaved: boolean;
  reveal: boolean;
  setReveal: (v: boolean) => void;
  unsavedConnectedLabel: string | null;
}) {
  const isDirty = draft.trim() !== saved;
  const isSaved = !!saved;

  return (
    <SettingCard accent={accent} accent2={accent2}>
      <SettingHeader icon={Icon} title={title} accent={accent} />
      <p className="text-white/60 text-sm mb-3">{description}</p>

      <div className="relative flex gap-2 items-center">
        <input
          type={reveal ? "text" : "password"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 h-14 pl-5 pr-12 rounded-full border-4 bg-[#0D0D1A]/60 font-bold text-white placeholder:text-white/30 focus:outline-none focus:border-[#FFE600] transition-colors"
          style={{ borderColor: accent }}
          aria-label={title}
        />
        <button
          type="button"
          onClick={() => setReveal(!reveal)}
          className="absolute right-4 top-1/2 -translate-y-1/2 text-white/40 hover:text-white transition-colors p-1"
          aria-label={reveal ? "Hide key" : "Show key"}
        >
          {reveal ? <EyeOff size={18} strokeWidth={3} /> : <Eye size={18} strokeWidth={3} />}
        </button>
      </div>

      {/* Status row — clarifies whether the typed value is actually persisted */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {isSaved ? (
          <span
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] uppercase tracking-widest font-black border-2 bg-[#4ADE80]/10 border-[#4ADE80] text-[#4ADE80]"
            title={`Stored in localStorage ("edgeboard-settings"). Persists across reloads and browser restarts until you reset settings.`}
          >
            <Check size={11} strokeWidth={3} /> saved · {maskKey(saved)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] uppercase tracking-widest font-black border-2 border-dashed border-[#FF6B35] text-[#FF6B35] bg-[#FF6B35]/10">
            ● not saved yet
          </span>
        )}

        {isDirty && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] uppercase tracking-widest font-black border-2 border-dashed border-[#FFE600] text-[#FFE600] bg-[#FFE600]/10 animate-pulse">
            typing · autosaves in 0.6s
          </span>
        )}

        {justSaved && !isDirty && (
          <motion.span
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] uppercase tracking-widest font-black bg-[#FFE600] text-[#0D0D1A]"
          >
            <Check size={11} strokeWidth={3} /> just saved!
          </motion.span>
        )}

        {!isSaved && !isDirty && unsavedConnectedLabel && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] uppercase tracking-widest font-bold border-2 border-white/15 text-white/50">
            {unsavedConnectedLabel}
          </span>
        )}
      </div>
    </SettingCard>
  );
}

function SettingCard({
  children,
  accent,
  accent2,
}: {
  children: React.ReactNode;
  accent: string;
  accent2: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      className="relative rounded-3xl border-4 p-6 md:p-8 backdrop-blur-sm bg-[#2D1B4E]/60"
      style={{ borderColor: accent, boxShadow: `5px 5px 0 ${accent2}` }}
    >
      {children}
    </motion.div>
  );
}

function SettingHeader({
  icon: Icon,
  title,
  accent,
}: {
  icon: typeof Key;
  title: string;
  accent: string;
}) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <div
        className="w-10 h-10 rounded-xl border-4 flex items-center justify-center"
        style={{ borderColor: accent, color: accent }}
      >
        <Icon size={18} strokeWidth={3} aria-hidden />
      </div>
      <h2 className="font-[family-name:var(--font-heading)] font-black uppercase tracking-wider text-xl text-shadow-1">
        {title}
      </h2>
    </div>
  );
}

/**
 * Toggle to enable the trained isotonic calibration corrector on the
 * live projection pipeline. Reads from /api/backtest/report so the user
 * sees whether a calibration model is even present before flipping the
 * switch (we don't enable corrections we don't have).
 *
 * Off by default. Live model is unaffected until the user opts in.
 */
function CalibrationToggleCard() {
  const enabled = useSettingsStore((s) => s.calibrationEnabled);
  const setEnabled = useSettingsStore((s) => s.setCalibrationEnabled);
  const [hasModel, setHasModel] = useState<boolean | null>(null);
  const [trainingSize, setTrainingSize] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/backtest/report");
        if (!r.ok || cancelled) return;
        const body = (await r.json()) as {
          available: boolean;
          calibration?: { trainingSize?: number } | null;
        };
        if (cancelled) return;
        if (body.available && body.calibration) {
          setHasModel(true);
          setTrainingSize(body.calibration.trainingSize ?? 0);
        } else {
          setHasModel(false);
        }
      } catch {
        if (!cancelled) setHasModel(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SettingCard accent="#7B2FFF" accent2="#FFE600">
      <SettingHeader icon={Wand2} title="Backtest calibration" accent="#7B2FFF" />
      <p className="text-white/60 text-sm mb-4">
        When on, every projection&apos;s hit probability is passed through the trained
        isotonic corrector before being shown. The corrector is fit by{" "}
        <code className="px-1.5 py-0.5 rounded bg-[#0D0D1A] text-[#00F5D4] text-xs">
          npx tsx scripts/backtest.ts
        </code>{" "}
        and reviewed in Model Lab.
      </p>
      <div className="flex items-center gap-3">
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!hasModel}
            onChange={(e) => setEnabled(e.target.checked)}
            className="w-5 h-5 accent-[#7B2FFF]"
          />
          <span className="font-[family-name:var(--font-heading)] font-black uppercase tracking-widest text-sm text-white/85">
            {enabled ? "Calibration on" : "Calibration off"}
          </span>
        </label>
        <span className="text-white/45 text-xs">
          {hasModel === null
            ? "Checking for model…"
            : hasModel
              ? `Model fit on ${trainingSize.toLocaleString()} picks`
              : "No model on disk — run the script first"}
        </span>
      </div>
    </SettingCard>
  );
}

function StatBox({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-2xl border-4 p-3 text-center" style={{ borderColor: accent }}>
      <div className="text-white/60 text-[10px] uppercase tracking-widest font-bold">{label}</div>
      <div
        className="font-[family-name:var(--font-display)] text-2xl mt-1 truncate"
        style={{ color: accent }}
      >
        {value}
      </div>
    </div>
  );
}
