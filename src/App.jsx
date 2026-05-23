import { useState, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { supabase } from "./supabase.js";

// ── Brand colors ──────────────────────────────────────────────
const B = { black: "#111111", red: "#CC2200", white: "#FFFFFF", charcoal: "#555555", gray: "#F5F5F5", border: "#DDDDDD" };

// ── Upload password (set via Netlify env var) ─────────────────
const UPLOAD_PASSWORD = import.meta.env.VITE_UPLOAD_PASSWORD || "impactkitchen";

// ── Fiscal calendar (placeholder — swap in real periods) ──────
const FISCAL_PERIODS = [
  { period: 1,  label: "P1",  start: "2025-09-15", end: "2025-10-12" },
  { period: 2,  label: "P2",  start: "2025-10-13", end: "2025-11-09" },
  { period: 3,  label: "P3",  start: "2025-11-10", end: "2025-12-07" },
  { period: 4,  label: "P4",  start: "2025-12-08", end: "2026-01-04" },
  { period: 5,  label: "P5",  start: "2026-01-05", end: "2026-02-01" },
  { period: 6,  label: "P6",  start: "2026-02-02", end: "2026-03-01" },
  { period: 7,  label: "P7",  start: "2026-03-02", end: "2026-03-29" },
  { period: 8,  label: "P8",  start: "2026-03-30", end: "2026-04-26" },
  { period: 9,  label: "P9",  start: "2026-04-27", end: "2026-05-24" },
  { period: 10, label: "P10", start: "2026-05-25", end: "2026-06-21" },
  { period: 11, label: "P11", start: "2026-06-22", end: "2026-07-19" },
  { period: 12, label: "P12", start: "2026-07-20", end: "2026-08-16" },
  { period: 13, label: "P13", start: "2026-08-17", end: "2026-09-13" },
];

function getPeriodForDate(dateStr) {
  const d = new Date(dateStr);
  for (const p of FISCAL_PERIODS) {
    if (d >= new Date(p.start) && d <= new Date(p.end)) return p;
  }
  return null;
}

function getFiscalYearStart(dateStr) {
  const d = new Date(dateStr);
  const sep15ThisYear = new Date(d.getFullYear() + "-09-15");
  return d >= sep15ThisYear ? sep15ThisYear : new Date((d.getFullYear() - 1) + "-09-15");
}

// ── CSV parser ────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const headerIdx = lines.findIndex(l => l.includes("Submitted At") && l.includes("Location"));
  if (headerIdx === -1) return [];
  const headers = lines[headerIdx].split("!");
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = lines[i].split("!");
    if (cols.length < headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h.trim()] = (cols[idx] || "").trim(); });
    rows.push(row);
  }
  return rows;
}

function buildAudits(rows) {
  const map = {};
  for (const r of rows) {
    const key = `${r["Submitted At"]}__${r["Location"]}`;
    if (!map[key]) {
      map[key] = {
        audit_key: key,
        submitted_at: r["Submitted At"],
        date: r["Submitted Date (MM/DD/YYYY)"],
        location: r["Location"],
        audit_score: parseFloat(r["Audit Score"]) || 0,
        tasks: [],
      };
    }
    if (r["Task Name"] && r["Task Status"]) {
      map[key].tasks.push({
        name: r["Task Name"].trim(),
        status: r["Task Status"].trim(),
        value: r["Task Value"].trim(),
        category: r["Category"].trim(),
      });
    }
  }
  return Object.values(map).filter(a => a.location && a.date);
}

// ── Task matchers ─────────────────────────────────────────────
const FIRST_TIMER_KEY = "First-Timer";
const SUGGESTIVE_KEY  = "suggestive selling";

function matchTask(taskName, key) {
  return taskName.toLowerCase().includes(key.toLowerCase());
}

function getTaskResult(tasks, key) {
  const t = tasks.find(t => matchTask(t.name, key));
  if (!t) return null;
  return t.status === "Pass" ? "Pass" : t.status === "Fail" ? "Fail" : null;
}

function getWeekLabel(dateStr) {
  const parts = dateStr.split("/");
  if (parts.length < 3) return dateStr;
  const d = new Date(`${parts[2]}-${parts[0]}-${parts[1]}`);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const mon = new Date(d.setDate(diff));
  return `${mon.toLocaleString("default", { month: "short" })} ${mon.getDate()}`;
}

function isoDate(mmddyyyy) {
  const p = mmddyyyy.split("/");
  if (p.length < 3) return mmddyyyy;
  return `${p[2]}-${p[0].padStart(2,"0")}-${p[1].padStart(2,"0")}`;
}

const FAIL_TASKS = [
  "Above & beyond customer service was observed",
  "strong 'server' presence",
  "First-Timer",
  "greeted when leaving",
  "Table touches were conducted within 3 minutes",
  "suggestive selling",
  "Retail fridge was clean",
  "Food looked fresh well-portioned",
  "prompt the guest for their Loyalty Membership",
  "Takeout & Delivery orders labelled",
];
const FAIL_LABELS = [
  "Above & beyond customer service observed",
  "Strong server presence (water 2 min, cutlery with food)",
  "First-Timer Guest Journey followed by all staff",
  "Guests greeted when leaving",
  "Table touches within 3 min, block removed",
  "Suggestive selling during order build",
  "Retail fridge clean, fully stocked, organized",
  "Food fresh, well-portioned, plated to SOP",
  "POS prompts for Loyalty at start of transaction",
  "Takeout orders labelled per Expo SOP",
];

const CAT_KEYS   = ["Exterior", "Washroom", "Beverage", "POS", "Food", "Retail", "Interior", "Customer Service"];
const CAT_LABELS = ["Exterior", "Washrooms", "Beverage", "POS", "Food", "Retail", "Interior", "Customer Svc"];

function catColor(score) {
  if (score >= 75) return B.black;
  if (score >= 55) return B.charcoal;
  return B.red;
}

// ── Shared UI ─────────────────────────────────────────────────
function SL({ children }) {
  return <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: B.charcoal, margin: "22px 0 10px" }}>{children}</p>;
}
function Card({ children, style }) {
  return <div style={{ border: `0.5px solid ${B.border}`, borderRadius: 10, padding: "14px 16px", background: B.white, ...style }}>{children}</div>;
}
function LocBadge({ loc }) {
  return <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 9px", borderRadius: 10, background: loc === "NoMad" ? B.red : B.black, color: B.white, display: "inline-block" }}>{loc}</span>;
}
function PassBadge({ val }) {
  if (!val) return <span style={{ fontSize: 11, color: "#aaa" }}>—</span>;
  return <span style={{ fontSize: 11, fontWeight: 700, color: val === "Pass" ? B.black : B.red }}>{val}</span>;
}

// ═══════════════════════════════════════════════════════════════
export default function App() {
  const [allAudits, setAllAudits] = useState([]);
  const [tab, setTab]             = useState("overview");
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [filterLoc, setFilterLoc] = useState("All");
  const [dateFilter, setDateFilter] = useState("ytd");
  const [loading, setLoading]     = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const fileRef = useRef();

  // Load from Supabase on mount
  useEffect(() => {
    loadAudits();
  }, []);

  async function loadAudits() {
    setLoading(true);
    const { data, error } = await supabase
      .from("audits")
      .select("*")
      .order("date", { ascending: true });
    if (!error && data) {
      setAllAudits(data.map(r => ({ ...r, auditScore: r.audit_score })));
    }
    setLoading(false);
  }

  function handlePasswordSubmit() {
    if (passwordInput === UPLOAD_PASSWORD) {
      setAuthenticated(true);
      setPasswordError("");
    } else {
      setPasswordError("Incorrect password.");
    }
  }

  async function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    setUploadMsg("");
    const text = await file.text();
    const rows = parseCSV(text);
    const newAudits = buildAudits(rows);
    if (!newAudits.length) {
      setUploadMsg("⚠️ No valid audits found in this file.");
      setUploading(false);
      return;
    }
    const existingKeys = new Set(allAudits.map(a => a.audit_key));
    const toInsert = newAudits
      .filter(a => !existingKeys.has(a.audit_key))
      .map(a => ({
        audit_key:   a.audit_key,
        submitted_at: a.submitted_at,
        date:        a.date,
        location:    a.location,
        audit_score: a.audit_score,
        tasks:       a.tasks,
      }));
    if (!toInsert.length) {
      setUploadMsg("All audits in this file are already loaded.");
      setUploading(false);
      return;
    }
    const { error } = await supabase.from("audits").insert(toInsert);
    if (error) {
      setUploadMsg(`⚠️ Upload error: ${error.message}`);
    } else {
      setUploadMsg(`✓ Added ${toInsert.length} new audit${toInsert.length !== 1 ? "s" : ""}${newAudits.length - toInsert.length > 0 ? ` (${newAudits.length - toInsert.length} already loaded)` : ""}.`);
      await loadAudits();
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  // ── Derived data ────────────────────────────────────────────
  const sorted   = [...allAudits].sort((a, b) => new Date(isoDate(a.date)) - new Date(isoDate(b.date)));
  const locFiltered = filterLoc === "All" ? sorted : sorted.filter(a => a.location === filterLoc);

  const today         = new Date();
  const currentPeriod = getPeriodForDate(today.toISOString().slice(0,10));
  const fyStart       = getFiscalYearStart(today.toISOString().slice(0,10));

  // Current quarter bounds
  function getCurrentQuarter() {
    if (!currentPeriod) return null;
    const p = currentPeriod.period;
    if (p <= 4)  return { start: FISCAL_PERIODS[0].start,  end: FISCAL_PERIODS[3].end };
    if (p <= 7)  return { start: FISCAL_PERIODS[4].start,  end: FISCAL_PERIODS[6].end };
    if (p <= 10) return { start: FISCAL_PERIODS[7].start,  end: FISCAL_PERIODS[9].end };
    return { start: FISCAL_PERIODS[10].start, end: FISCAL_PERIODS[12].end };
  }

  // This week: Mon–Sun
  function getThisWeekRange() {
    const d = new Date(today);
    const day = d.getDay();
    const mon = new Date(d); mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { start: mon, end: sun };
  }

  function applyDateFilter(audits) {
    if (dateFilter === "ytd") {
      return audits.filter(a => { const d = new Date(isoDate(a.date)); return d >= fyStart && d <= today; });
    }
    if (dateFilter === "period" && currentPeriod) {
      return audits.filter(a => { const d = new Date(isoDate(a.date)); return d >= new Date(currentPeriod.start) && d <= new Date(currentPeriod.end); });
    }
    if (dateFilter === "quarter") {
      const q = getCurrentQuarter();
      if (!q) return audits;
      return audits.filter(a => { const d = new Date(isoDate(a.date)); return d >= new Date(q.start) && d <= new Date(q.end); });
    }
    if (dateFilter === "week") {
      const { start, end } = getThisWeekRange();
      return audits.filter(a => { const d = new Date(isoDate(a.date)); return d >= start && d <= end; });
    }
    // Prior period selected e.g. "P1", "P2" etc
    const priorP = FISCAL_PERIODS.find(p => p.label === dateFilter);
    if (priorP) {
      return audits.filter(a => { const d = new Date(isoDate(a.date)); return d >= new Date(priorP.start) && d <= new Date(priorP.end); });
    }
    return audits;
  }

  const filtered = applyDateFilter(locFiltered);
  const nmAudits = filtered.filter(a => a.location === "NoMad");
  const wbAudits = filtered.filter(a => a.location === "Williamsburg");

  // Overview PTD/YTD always uses locFiltered (unaffected by date filter)
  const periodAudits = locFiltered.filter(a => {
    if (!currentPeriod) return false;
    const d = new Date(isoDate(a.date));
    return d >= new Date(currentPeriod.start) && d <= new Date(currentPeriod.end);
  });
  const ytdAudits = locFiltered.filter(a => {
    const d = new Date(isoDate(a.date));
    return d >= fyStart && d <= today;
  });

  function avgScore(audits) {
    if (!audits.length) return "—";
    return (audits.reduce((s, a) => s + (a.auditScore ?? a.audit_score ?? 0), 0) / audits.length).toFixed(1);
  }

  const weekMap = {};
  for (const a of filtered) {
    const wk = getWeekLabel(a.date);
    if (!weekMap[wk]) weekMap[wk] = { week: wk, NoMad: [], Williamsburg: [] };
    if (a.location === "NoMad" || a.location === "Williamsburg") weekMap[wk][a.location].push(a.auditScore ?? a.audit_score);
  }
  const weekTrend = Object.values(weekMap).map(w => ({
    week: w.week,
    NoMad: w.NoMad.length ? +(w.NoMad.reduce((s,v)=>s+v,0)/w.NoMad.length).toFixed(1) : null,
    Williamsburg: w.Williamsburg.length ? +(w.Williamsburg.reduce((s,v)=>s+v,0)/w.Williamsburg.length).toFixed(1) : null,
  }));

  function catAvg(audits, catKeyword) {
    const scores = [];
    for (const a of audits) {
      const tasks = a.tasks || [];
      const catTasks = tasks.filter(t => t.category.toLowerCase().includes(catKeyword.toLowerCase()));
      if (!catTasks.length) continue;
      const scored = catTasks.filter(t => t.status === "Pass" || t.status === "Fail");
      if (!scored.length) continue;
      const passes = scored.filter(t => t.status === "Pass").length;
      scores.push(Math.round((passes / scored.length) * 100));
    }
    return scores.length ? Math.round(scores.reduce((s,v)=>s+v,0)/scores.length) : null;
  }

  function buildCatRows(audits) {
    return CAT_KEYS.map((k, i) => ({ name: CAT_LABELS[i], score: catAvg(audits, k) }))
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }

  function failRate(audits, keyword) {
    const tasks_audits = audits.filter(a => (a.tasks||[]).some(t => matchTask(t.name, keyword)));
    if (!tasks_audits.length) return null;
    const gaps = tasks_audits.filter(a => (a.tasks||[]).some(t => matchTask(t.name, keyword) && t.status === "Fail"));
    return Math.round((gaps.length / tasks_audits.length) * 100);
  }

  function keyMetricLog(audits, keyword) {
    return audits.map(a => ({
      date: a.date, location: a.location,
      auditScore: a.auditScore ?? a.audit_score,
      result: getTaskResult(a.tasks || [], keyword),
    })).filter(r => r.result !== null);
  }

  function keyMetricWeekTrend(keyword) {
    const wMap = {};
    for (const a of filtered) {
      const r = getTaskResult(a.tasks || [], keyword);
      if (!r) continue;
      const wk = getWeekLabel(a.date);
      if (!wMap[wk]) wMap[wk] = { week: wk, NoMad: { pass: 0, total: 0 }, Williamsburg: { pass: 0, total: 0 } };
      const loc = a.location;
      if (loc === "NoMad" || loc === "Williamsburg") {
        wMap[wk][loc].total++;
        if (r === "Pass") wMap[wk][loc].pass++;
      }
    }
    return Object.values(wMap).map(w => ({
      week: w.week,
      NoMad: w.NoMad.total ? Math.round((w.NoMad.pass / w.NoMad.total) * 100) : null,
      Williamsburg: w.Williamsburg.total ? Math.round((w.Williamsburg.pass / w.Williamsburg.total) * 100) : null,
    }));
  }

  const ftLog   = keyMetricLog(filtered, FIRST_TIMER_KEY);
  const ssLog   = keyMetricLog(filtered, SUGGESTIVE_KEY);
  const ftTrend = keyMetricWeekTrend(FIRST_TIMER_KEY);
  const ssTrend = keyMetricWeekTrend(SUGGESTIVE_KEY);

  const TABS = [
    { id: "overview",    label: "Overview" },
    { id: "categories",  label: "By Category" },
    { id: "gaps",        label: "Gap Analysis" },
    { id: "wins",        label: "Wins" },
    { id: "trends",      label: "Trends & Insights" },
    { id: "nycstrategy", label: "NYC Strategy Metrics" },
  ];

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: B.red, marginBottom: 8 }}>Impact Kitchen</div>
        <div style={{ fontSize: 12, color: B.charcoal }}>Loading audit data…</div>
      </div>
    </div>
  );

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 760, margin: "0 auto", padding: "0 16px 40px", color: B.black, background: B.white, minHeight: "100vh" }}>

      {/* Header */}
      <div style={{ background: B.black, margin: "0 -16px", padding: "16px 20px 14px", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: B.red, margin: "0 0 4px" }}>Impact Kitchen</p>
          <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: B.white }}>Restaurant Experience Survey</h1>
          <p style={{ fontSize: 11, color: "#aaa", margin: "3px 0 0" }}>
            {sorted.length ? `${sorted[0].date} – ${sorted[sorted.length-1].date}` : "No data loaded"} · {allAudits.length} audit{allAudits.length !== 1 ? "s" : ""} · NoMad & Williamsburg
          </p>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
          <LocBadge loc="NoMad" /><LocBadge loc="Williamsburg" />
        </div>
      </div>

      {/* Upload bar */}
      <div style={{ background: B.gray, margin: "0 -16px", padding: "10px 20px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", borderBottom: `1px solid ${B.border}` }}>
        {!showUpload ? (
          <button onClick={() => setShowUpload(true)} style={{ fontSize: 12, fontWeight: 600, background: B.red, color: B.white, padding: "5px 14px", borderRadius: 6, cursor: "pointer", border: "none" }}>
            + Upload weekly CSV
          </button>
        ) : !authenticated ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="password"
              placeholder="Upload password"
              value={passwordInput}
              onChange={e => setPasswordInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handlePasswordSubmit()}
              style={{ fontSize: 12, padding: "5px 10px", borderRadius: 6, border: `1px solid ${B.border}`, outline: "none" }}
            />
            <button onClick={handlePasswordSubmit} style={{ fontSize: 12, fontWeight: 600, background: B.black, color: B.white, padding: "5px 14px", borderRadius: 6, cursor: "pointer", border: "none" }}>
              Unlock
            </button>
            <button onClick={() => { setShowUpload(false); setPasswordInput(""); setPasswordError(""); }} style={{ fontSize: 11, color: B.charcoal, background: "none", border: "none", cursor: "pointer" }}>
              Cancel
            </button>
            {passwordError && <span style={{ fontSize: 11, color: B.red }}>{passwordError}</span>}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label style={{ fontSize: 12, fontWeight: 600, background: B.red, color: B.white, padding: "5px 14px", borderRadius: 6, cursor: "pointer" }}>
              {uploading ? "Loading…" : "Choose CSV"}
              <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleFile} disabled={uploading} />
            </label>
            <button onClick={() => { setShowUpload(false); setAuthenticated(false); setPasswordInput(""); }} style={{ fontSize: 11, color: B.charcoal, background: "none", border: "none", cursor: "pointer" }}>
              Done
            </button>
          </div>
        )}
        {uploadMsg && <span style={{ fontSize: 11, color: uploadMsg.startsWith("⚠") ? B.red : B.black }}>{uploadMsg}</span>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: B.charcoal }}>Filter:</span>
          {["All","NoMad","Williamsburg"].map(l => (
            <button key={l} onClick={() => setFilterLoc(l)} style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20, border: `1px solid ${filterLoc === l ? B.black : B.border}`, background: filterLoc === l ? B.black : B.white, color: filterLoc === l ? B.white : B.charcoal, cursor: "pointer" }}>{l}</button>
          ))}
        </div>
      </div>

      {/* Date filter bar */}
      <div style={{ background: B.white, margin: "0 -16px", padding: "8px 20px", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", borderBottom: `1px solid ${B.border}` }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: B.charcoal, marginRight: 4 }}>Viewing:</span>
        {[
          { id: "week",   label: "This Week" },
          { id: "period", label: `This Period${currentPeriod ? ` (${currentPeriod.label})` : ""}` },
          { id: "quarter", label: "This Quarter" },
          { id: "ytd",    label: "YTD" },
        ].map(f => (
          <button key={f.id} onClick={() => setDateFilter(f.id)} style={{ fontSize: 11, fontWeight: 600, padding: "3px 11px", borderRadius: 20, border: `1px solid ${dateFilter === f.id ? B.red : B.border}`, background: dateFilter === f.id ? B.red : B.white, color: dateFilter === f.id ? B.white : B.charcoal, cursor: "pointer", whiteSpace: "nowrap" }}>
            {f.label}
          </button>
        ))}
        <div style={{ width: 1, height: 18, background: B.border, margin: "0 4px" }} />
        <select
          value={FISCAL_PERIODS.find(p => p.label === dateFilter) ? dateFilter : ""}
          onChange={e => e.target.value && setDateFilter(e.target.value)}
          style={{ fontSize: 11, padding: "3px 8px", borderRadius: 20, border: `1px solid ${FISCAL_PERIODS.find(p => p.label === dateFilter) ? B.red : B.border}`, background: FISCAL_PERIODS.find(p => p.label === dateFilter) ? B.red : B.white, color: FISCAL_PERIODS.find(p => p.label === dateFilter) ? B.white : B.charcoal, cursor: "pointer", outline: "none" }}
        >
          <option value="">By Period…</option>
          {FISCAL_PERIODS.filter(p => !currentPeriod || p.period < currentPeriod.period).map(p => (
            <option key={p.label} value={p.label}>{p.label} ({p.start} – {p.end})</option>
          ))}
        </select>
        {filtered.length > 0 && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: B.charcoal }}>{filtered.length} audit{filtered.length !== 1 ? "s" : ""} in view</span>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: `2px solid ${B.border}`, marginBottom: 20, overflowX: "auto" }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ fontSize: 12, fontWeight: 600, padding: "8px 14px", border: "none", background: "none", cursor: "pointer", color: tab === t.id ? B.red : B.charcoal, borderBottom: tab === t.id ? `2px solid ${B.red}` : "2px solid transparent", marginBottom: -2, whiteSpace: "nowrap" }}>
            {t.label}
          </button>
        ))}
      </div>

      {!allAudits.length && (
        <div style={{ textAlign: "center", padding: "60px 20px", color: B.charcoal }}>
          <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: B.black }}>No audit data loaded</p>
          <p style={{ fontSize: 12 }}>Click "+ Upload weekly CSV" above to get started.</p>
        </div>
      )}

      {/* ── OVERVIEW ── */}
      {tab === "overview" && allAudits.length > 0 && (
        <div>
          <SL>Period-to-date {currentPeriod ? `(${currentPeriod.label}: ${currentPeriod.start} – ${currentPeriod.end})` : "(placeholder — upload fiscal calendar)"}</SL>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 14 }}>
            {[
              { label: "PTD Combined avg", val: avgScore(periodAudits), sub: `${periodAudits.length} audit${periodAudits.length !== 1 ? "s" : ""}` },
              { label: "PTD NoMad avg",    val: avgScore(periodAudits.filter(a => a.location === "NoMad")),        sub: "NoMad" },
              { label: "PTD WB avg",       val: avgScore(periodAudits.filter(a => a.location === "Williamsburg")), sub: "Williamsburg" },
            ].map(m => (
              <div key={m.label} style={{ background: B.black, borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ fontSize: 10, color: "#aaa", marginBottom: 4 }}>{m.label}</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: B.red }}>{m.val}</div>
                <div style={{ fontSize: 10, color: "#666", marginTop: 2 }}>{m.sub}</div>
              </div>
            ))}
          </div>

          <SL>Year-to-date (FY starts Sep 15)</SL>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 14 }}>
            {[
              { label: "YTD Combined avg", val: avgScore(ytdAudits), sub: `${ytdAudits.length} audits` },
              { label: "YTD NoMad avg",    val: avgScore(ytdAudits.filter(a => a.location === "NoMad")),        sub: "NoMad" },
              { label: "YTD WB avg",       val: avgScore(ytdAudits.filter(a => a.location === "Williamsburg")), sub: "Williamsburg" },
            ].map(m => (
              <div key={m.label} style={{ background: B.gray, borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ fontSize: 10, color: B.charcoal, marginBottom: 4 }}>{m.label}</div>
                <div style={{ fontSize: 24, fontWeight: 700, color: B.black }}>{m.val}</div>
                <div style={{ fontSize: 10, color: "#999", marginTop: 2 }}>{m.sub}</div>
              </div>
            ))}
          </div>

          <SL>Week-over-week trend</SL>
          <Card>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={weekTrend} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={B.border} />
                <XAxis dataKey="week" tick={{ fontSize: 10, fill: B.charcoal }} />
                <YAxis domain={[50, 100]} tick={{ fontSize: 10, fill: B.charcoal }} />
                <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="NoMad" stroke={B.red} strokeWidth={2} dot={{ r: 4, fill: B.red }} connectNulls />
                <Line type="monotone" dataKey="Williamsburg" stroke={B.black} strokeWidth={2} dot={{ r: 4, fill: B.black }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <SL>All audits</SL>
          <Card>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px 70px 60px", gap: 0 }}>
              {["Date","Location","Score","Period"].map(h => (
                <div key={h} style={{ fontSize: 10, fontWeight: 700, color: B.charcoal, textTransform: "uppercase", letterSpacing: "0.06em", padding: "4px 0 8px", borderBottom: `1px solid ${B.border}` }}>{h}</div>
              ))}
              {filtered.map((a, i) => {
                const p = getPeriodForDate(isoDate(a.date));
                const score = a.auditScore ?? a.audit_score;
                return [
                  <div key={`d${i}`} style={{ fontSize: 12, padding: "7px 0", borderBottom: `0.5px solid ${B.border}`, color: B.black }}>{a.date}</div>,
                  <div key={`l${i}`} style={{ fontSize: 12, padding: "7px 0", borderBottom: `0.5px solid ${B.border}` }}><LocBadge loc={a.location} /></div>,
                  <div key={`s${i}`} style={{ fontSize: 13, fontWeight: 700, padding: "7px 0", borderBottom: `0.5px solid ${B.border}`, color: score >= 75 ? B.black : B.red }}>{score.toFixed(1)}</div>,
                  <div key={`p${i}`} style={{ fontSize: 11, padding: "7px 0", borderBottom: `0.5px solid ${B.border}`, color: B.charcoal }}>{p ? p.label : "—"}</div>,
                ];
              })}
            </div>
          </Card>
        </div>
      )}

      {/* ── CATEGORIES ── */}
      {tab === "categories" && allAudits.length > 0 && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {[{ label: "NoMad", audits: nmAudits }, { label: "Williamsburg", audits: wbAudits }].map(({ label, audits }) => (
              <Card key={label}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                  <LocBadge loc={label} />
                  <span style={{ fontSize: 11, color: B.charcoal }}>{audits.length} audit{audits.length !== 1 ? "s" : ""}</span>
                </div>
                {buildCatRows(audits).map(c => (
                  <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <span style={{ width: 90, fontSize: 11.5, color: B.charcoal, flexShrink: 0 }}>{c.name}</span>
                    <div style={{ flex: 1, height: 5, background: B.border, borderRadius: 3, overflow: "hidden" }}>
                      {c.score !== null && <div style={{ width: `${c.score}%`, height: "100%", background: catColor(c.score), borderRadius: 3 }} />}
                    </div>
                    <span style={{ width: 30, fontSize: 12, fontWeight: 700, textAlign: "right", color: c.score !== null ? catColor(c.score) : B.charcoal }}>{c.score ?? "—"}</span>
                  </div>
                ))}
              </Card>
            ))}
          </div>

          <SL>PTD vs YTD — combined category comparison</SL>
          <Card>
            <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 50px 1fr 50px", gap: 0, alignItems: "center" }}>
              {["Category","PTD","","YTD",""].map((h,i) => (
                <div key={i} style={{ fontSize: 10, fontWeight: 700, color: B.charcoal, textTransform: "uppercase", letterSpacing: "0.06em", padding: "4px 0 8px", borderBottom: `1px solid ${B.border}` }}>{h}</div>
              ))}
              {CAT_KEYS.map((k, i) => {
                const ptd = catAvg(periodAudits, k);
                const ytd = catAvg(ytdAudits, k);
                return [
                  <div key={`n${i}`} style={{ fontSize: 12, padding: "7px 0", borderBottom: `0.5px solid ${B.border}`, color: B.black }}>{CAT_LABELS[i]}</div>,
                  <div key={`pb${i}`} style={{ padding: "7px 4px", borderBottom: `0.5px solid ${B.border}` }}>
                    <div style={{ height: 5, background: B.border, borderRadius: 3, overflow: "hidden" }}>
                      {ptd !== null && <div style={{ width: `${ptd}%`, height: "100%", background: catColor(ptd), borderRadius: 3 }} />}
                    </div>
                  </div>,
                  <div key={`pv${i}`} style={{ fontSize: 12, fontWeight: 700, padding: "7px 0", borderBottom: `0.5px solid ${B.border}`, color: ptd !== null ? catColor(ptd) : B.charcoal, textAlign: "right" }}>{ptd ?? "—"}</div>,
                  <div key={`yb${i}`} style={{ padding: "7px 4px", borderBottom: `0.5px solid ${B.border}` }}>
                    <div style={{ height: 5, background: B.border, borderRadius: 3, overflow: "hidden" }}>
                      {ytd !== null && <div style={{ width: `${ytd}%`, height: "100%", background: catColor(ytd), opacity: 0.5, borderRadius: 3 }} />}
                    </div>
                  </div>,
                  <div key={`yv${i}`} style={{ fontSize: 12, fontWeight: 700, padding: "7px 0", borderBottom: `0.5px solid ${B.border}`, color: ytd !== null ? catColor(ytd) : B.charcoal, textAlign: "right" }}>{ytd ?? "—"}</div>,
                ];
              })}
            </div>
          </Card>
        </div>
      )}

      {/* ── GAP ANALYSIS ── */}
      {tab === "gaps" && allAudits.length > 0 && (
        <div>
          <Card style={{ overflow: "hidden", padding: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 80px", padding: "8px 16px", background: B.black, fontSize: 10, fontWeight: 700, color: B.white, textTransform: "uppercase", letterSpacing: "0.07em" }}>
              <span>Standard</span><span style={{ textAlign: "right" }}>Combined</span><span style={{ textAlign: "right" }}>NoMad</span><span style={{ textAlign: "right" }}>WB</span>
            </div>
            {FAIL_TASKS.map((key, i) => {
              const combined = failRate(filtered, key);
              const nm       = failRate(nmAudits, key);
              const wb       = failRate(wbAudits, key);
              const sev = (combined ?? 0) >= 60 ? "high" : "med";
              return (
                <div key={key} style={{ padding: "10px 16px", borderTop: `0.5px solid ${B.border}`, background: B.white }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    <span style={{ flex: 1, fontSize: 12, color: B.black, lineHeight: 1.4 }}>{FAIL_LABELS[i]}</span>
                    <span style={{ width: 44, textAlign: "right", fontSize: 13, fontWeight: 700, color: sev === "high" ? B.red : B.charcoal }}>{combined !== null ? `${combined}%` : "—"}</span>
                    <span style={{ width: 44, textAlign: "right", fontSize: 12, color: (nm ?? 0) >= 60 ? B.red : B.charcoal }}>{nm !== null ? `${nm}%` : "—"}</span>
                    <span style={{ width: 44, textAlign: "right", fontSize: 12, color: (wb ?? 0) >= 60 ? B.red : B.charcoal }}>{wb !== null ? `${wb}%` : "—"}</span>
                  </div>
                  <div style={{ height: 4, background: B.gray, borderRadius: 2 }}>
                    {combined !== null && <div style={{ height: "100%", width: `${combined}%`, background: sev === "high" ? B.red : B.charcoal, borderRadius: 2 }} />}
                  </div>
                </div>
              );
            })}
          </Card>
          <SL>Priority focus areas</SL>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { area: "Floor service execution", detail: "4 of the top 5 gaps are floor-level behaviors — greeting on exit, server presence, table touches, First-Timer Journey. One focused shift of standards reinforcement with GMs." },
              { area: "Retail fridge stocking",  detail: "Consistent gap across both locations — likely a mid-shift or end-of-day lapse. Add a stocking checkpoint to the shift checklist." },
              { area: "Food plating to SOP",     detail: "Connect to BOH standards review and COGS/portioning work." },
              { area: "POS loyalty & suggestive selling", detail: "Direct impact on average cheque and loyalty subscriber growth. See NYC Strategy Metrics tab for audit-by-audit breakdown." },
            ].map((a, i) => (
              <div key={a.area} style={{ border: `0.5px solid ${B.border}`, borderRadius: 8, padding: "12px 14px", display: "flex", gap: 12 }}>
                <div style={{ width: 24, height: 24, borderRadius: "50%", background: i === 0 ? B.red : B.black, color: B.white, fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 3, color: B.black }}>{a.area}</div>
                  <div style={{ fontSize: 11.5, color: B.charcoal, lineHeight: 1.6 }}>{a.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── WINS ── */}
      {tab === "wins" && allAudits.length > 0 && (() => {
        const WIN_THRESHOLD = 80;
        const winRows = FAIL_TASKS.map((key, i) => {
          const combined = failRate(filtered, key);
          const nm = failRate(nmAudits, key);
          const wb = failRate(wbAudits, key);
          return { label: FAIL_LABELS[i], passRate: combined !== null ? 100 - combined : null, nmPassRate: nm !== null ? 100 - nm : null, wbPassRate: wb !== null ? 100 - wb : null };
        }).filter(r => r.passRate !== null).sort((a, b) => b.passRate - a.passRate);

        const topAudits = [...filtered].sort((a, b) => (b.auditScore ?? b.audit_score) - (a.auditScore ?? a.audit_score)).slice(0, 5);

        const strongCats = CAT_KEYS.map((k, i) => ({ name: CAT_LABELS[i], nm: catAvg(nmAudits, k), wb: catAvg(wbAudits, k) }))
          .filter(c => (c.nm ?? 0) >= 85 || (c.wb ?? 0) >= 85);

        let mostImprovedLoc = null, mostImprovedDelta = 0, mostImprovedWeek = "";
        if (weekTrend.length >= 2) {
          for (let i = 1; i < weekTrend.length; i++) {
            for (const loc of ["NoMad","Williamsburg"]) {
              const prev = weekTrend[i-1][loc], curr = weekTrend[i][loc];
              if (prev !== null && curr !== null && curr - prev > mostImprovedDelta) {
                mostImprovedDelta = curr - prev;
                mostImprovedLoc = loc;
                mostImprovedWeek = weekTrend[i].week;
              }
            }
          }
        }

        return (
          <div>
            {mostImprovedLoc && (
              <div style={{ background: B.black, borderRadius: 10, padding: "16px 20px", marginBottom: 16, display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: B.red }}>+{mostImprovedDelta.toFixed(1)}</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: B.white }}>Biggest week-over-week improvement</div>
                  <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}><LocBadge loc={mostImprovedLoc} />&nbsp; week of {mostImprovedWeek}</div>
                </div>
              </div>
            )}
            <SL>Top scoring audits</SL>
            <Card style={{ overflow: "hidden", padding: 0, marginBottom: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 70px 60px", padding: "7px 16px", background: B.black, fontSize: 10, fontWeight: 700, color: B.white, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                <span>Date</span><span>Location</span><span style={{ textAlign: "right" }}>Score</span><span style={{ textAlign: "right" }}>Period</span>
              </div>
              {topAudits.map((a, i) => {
                const p = getPeriodForDate(isoDate(a.date));
                const score = a.auditScore ?? a.audit_score;
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "100px 1fr 70px 60px", padding: "9px 16px", borderTop: `0.5px solid ${B.border}`, alignItems: "center" }}>
                    <span style={{ fontSize: 11.5 }}>{a.date}</span>
                    <span><LocBadge loc={a.location} /></span>
                    <span style={{ fontSize: 14, fontWeight: 700, color: B.red, textAlign: "right" }}>{score.toFixed(1)}</span>
                    <span style={{ fontSize: 11, color: B.charcoal, textAlign: "right" }}>{p ? p.label : "—"}</span>
                  </div>
                );
              })}
            </Card>
            <SL>Standards consistently met</SL>
            <Card style={{ overflow: "hidden", padding: 0, marginBottom: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 80px", padding: "8px 16px", background: B.black, fontSize: 10, fontWeight: 700, color: B.white, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                <span>Standard</span><span style={{ textAlign: "right" }}>Combined</span><span style={{ textAlign: "right" }}>NoMad</span><span style={{ textAlign: "right" }}>WB</span>
              </div>
              {winRows.map((r, i) => (
                <div key={i} style={{ padding: "10px 16px", borderTop: `0.5px solid ${B.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    <span style={{ flex: 1, fontSize: 12, lineHeight: 1.4 }}>{r.label}</span>
                    <span style={{ width: 44, textAlign: "right", fontSize: 13, fontWeight: 700, color: r.passRate >= WIN_THRESHOLD ? B.black : B.charcoal }}>{r.passRate}%</span>
                    <span style={{ width: 44, textAlign: "right", fontSize: 12, color: (r.nmPassRate ?? 0) >= WIN_THRESHOLD ? B.black : B.charcoal }}>{r.nmPassRate !== null ? `${r.nmPassRate}%` : "—"}</span>
                    <span style={{ width: 44, textAlign: "right", fontSize: 12, color: (r.wbPassRate ?? 0) >= WIN_THRESHOLD ? B.black : B.charcoal }}>{r.wbPassRate !== null ? `${r.wbPassRate}%` : "—"}</span>
                  </div>
                  <div style={{ height: 4, background: B.gray, borderRadius: 2 }}>
                    <div style={{ height: "100%", width: `${r.passRate}%`, background: r.passRate >= WIN_THRESHOLD ? B.black : B.border, borderRadius: 2 }} />
                  </div>
                </div>
              ))}
            </Card>
            <SL>Categories consistently above 85</SL>
            {strongCats.length === 0 ? (
              <p style={{ fontSize: 12, color: B.charcoal }}>No categories averaging above 85 yet.</p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {strongCats.map(c => (
                  <div key={c.name} style={{ background: B.gray, borderRadius: 8, padding: "12px 14px" }}>
                    <div style={{ fontSize: 11, color: B.charcoal, marginBottom: 6 }}>{c.name}</div>
                    <div style={{ display: "flex", gap: 16 }}>
                      {c.nm !== null && <div><LocBadge loc="NoMad" /><div style={{ fontSize: 20, fontWeight: 700, color: c.nm >= 85 ? B.red : B.charcoal, marginTop: 4 }}>{c.nm}</div></div>}
                      {c.wb !== null && <div><LocBadge loc="Williamsburg" /><div style={{ fontSize: 20, fontWeight: 700, color: c.wb >= 85 ? B.black : B.charcoal, marginTop: 4 }}>{c.wb}</div></div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── TRENDS ── */}
      {/* ── TRENDS & INSIGHTS ── */}
      {tab === "trends" && allAudits.length > 0 && (() => {

        // ── Insight engine ────────────────────────────────────────
        const insights = { watch: [], strong: [], summary: [] };

        // Helper: gap rate for a keyword across an audit set
        const gapR = (audits, kw) => failRate(audits, kw);
        const passR = (audits, kw) => { const r = gapR(audits, kw); return r !== null ? 100 - r : null; };

        // Trend direction: compare first half vs second half of weekTrend per location
        function trendDirection(loc) {
          const pts = weekTrend.map(w => w[loc]).filter(v => v !== null);
          if (pts.length < 3) return null;
          const mid = Math.floor(pts.length / 2);
          const first = pts.slice(0, mid).reduce((s,v)=>s+v,0)/mid;
          const second = pts.slice(mid).reduce((s,v)=>s+v,0)/(pts.length-mid);
          return +(second - first).toFixed(1);
        }

        // Consecutive weeks missing a standard
        function consecutiveMisses(loc, keyword) {
          const locWeeks = weekTrend.map(w => w.week);
          const auditsByWeek = {};
          for (const a of filtered.filter(x => x.location === loc)) {
            const wk = getWeekLabel(a.date);
            if (!auditsByWeek[wk]) auditsByWeek[wk] = [];
            auditsByWeek[wk].push(a);
          }
          let streak = 0;
          for (let i = locWeeks.length - 1; i >= 0; i--) {
            const wkAudits = auditsByWeek[locWeeks[i]] || [];
            if (!wkAudits.length) break;
            const allMiss = wkAudits.every(a => {
              const t = (a.tasks||[]).find(t => matchTask(t.name, keyword));
              return t && t.status === "Fail";
            });
            if (allMiss) streak++;
            else break;
          }
          return streak;
        }

        // Period summary score context
        const nmScore = avgScore(nmAudits);
        const wbScore = avgScore(wbAudits);
        const nmTrendDelta = trendDirection("NoMad");
        const wbTrendDelta = trendDirection("Williamsburg");
        const filterLabel = dateFilter === "ytd" ? "year-to-date" : dateFilter === "period" ? `${currentPeriod?.label || "this period"}` : dateFilter === "quarter" ? "this quarter" : dateFilter === "week" ? "this week" : dateFilter;

        // ── Watch insights ────────────────────────────────────────
        for (const loc of ["NoMad", "Williamsburg"]) {
          const locA = filtered.filter(a => a.location === loc);
          if (!locA.length) continue;
          const delta = trendDirection(loc);

          // Declining trend
          if (delta !== null && delta <= -5) {
            insights.watch.push(`${loc} overall score has declined ${Math.abs(delta)} points across the ${filterLabel} window — a consistent downward trend, not a one-off.`);
          }

          // Consecutive standard misses
          const standardChecks = [
            { kw: "strong 'server' presence", label: "server presence on the floor" },
            { kw: "First-Timer", label: "First-Timer Guest Journey" },
            { kw: "greeted when leaving", label: "greeting guests on exit" },
            { kw: "Above & beyond", label: "above & beyond customer service" },
            { kw: "suggestive selling", label: "suggestive selling" },
            { kw: "Retail fridge", label: "retail fridge stocking" },
          ];
          for (const { kw, label } of standardChecks) {
            const streak = consecutiveMisses(loc, kw);
            if (streak >= 2) {
              insights.watch.push(`${loc} has missed the standard for ${label} ${streak} consecutive week${streak > 1 ? "s" : ""} in a row.`);
            }
          }

          // High gap rate on key standards
          const csGap = gapR(locA, "Above & beyond");
          if (csGap !== null && csGap >= 75) {
            insights.watch.push(`${loc} above & beyond customer service has a ${csGap}% gap rate ${filterLabel} — the most frequent miss in the dataset.`);
          }

          // Low overall score
          const sc = avgScore(locA);
          if (sc !== "—" && parseFloat(sc) < 72) {
            insights.watch.push(`${loc} is averaging ${sc} ${filterLabel} — below the 75-point threshold that indicates consistent standard execution.`);
          }
        }

        // Retail gap — both locations
        const retailGapNm = gapR(nmAudits, "Retail fridge");
        const retailGapWb = gapR(wbAudits, "Retail fridge");
        if ((retailGapNm ?? 0) >= 50 && (retailGapWb ?? 0) >= 50) {
          insights.watch.push(`Retail fridge stocking is a gap at both locations (${retailGapNm}% NoMad, ${retailGapWb}% WB) — indicates a systemic stocking or shift handoff issue, not location-specific.`);
        }

        // ── Strong insights ───────────────────────────────────────
        for (const loc of ["NoMad", "Williamsburg"]) {
          const locA = filtered.filter(a => a.location === loc);
          if (!locA.length) continue;
          const delta = trendDirection(loc);

          // Improving trend
          if (delta !== null && delta >= 5) {
            insights.strong.push(`${loc} overall score has improved ${delta} points across the ${filterLabel} window — a positive trend worth sustaining.`);
          }

          // Strong category scores
          for (const [k, label] of [["Exterior","exterior"], ["Washroom","washrooms"], ["Beverage","beverage execution"], ["Interior","interior presentation"]]) {
            const sc = catAvg(locA, k);
            if (sc !== null && sc >= 90) {
              insights.strong.push(`${loc} is averaging ${sc} on ${label} ${filterLabel} — a consistent strength.`);
            }
          }

          // Strong overall score
          const sc = avgScore(locA);
          if (sc !== "—" && parseFloat(sc) >= 82) {
            insights.strong.push(`${loc} is averaging ${sc} overall ${filterLabel} — above the 80-point benchmark for strong operational execution.`);
          }

          // Standards being met
          for (const { kw, label } of [
            { kw: "Food chit times", label: "food chit times" },
            { kw: "Beverage chit times", label: "beverage chit times" },
            { kw: "Washrooms were clean", label: "washroom standards" },
          ]) {
            const pr = passR(locA, kw);
            if (pr !== null && pr >= 85) {
              insights.strong.push(`${loc} is meeting the standard for ${label} at a ${pr}% rate ${filterLabel}.`);
            }
          }
        }

        // ── Period summary (executive-facing) ─────────────────────
        const hasWatch = insights.watch.length > 0;
        const hasStrong = insights.strong.length > 0;
        const nmStr = nmScore !== "—" ? `NoMad is averaging ${nmScore}` : null;
        const wbStr = wbScore !== "—" ? `Williamsburg is averaging ${wbScore}` : null;
        const scoreStr = [nmStr, wbStr].filter(Boolean).join(", ");

        if (scoreStr) {
          const trendStr = (() => {
            const parts = [];
            if (nmTrendDelta !== null) parts.push(`NoMad ${nmTrendDelta >= 0 ? "up" : "down"} ${Math.abs(nmTrendDelta)} pts`);
            if (wbTrendDelta !== null) parts.push(`Williamsburg ${wbTrendDelta >= 0 ? "up" : "down"} ${Math.abs(wbTrendDelta)} pts`);
            return parts.length ? ` Trend direction: ${parts.join(", ")}.` : "";
          })();
          insights.summary.push(`${scoreStr} for the ${filterLabel} window.${trendStr}`);
        }
        if (hasWatch) insights.summary.push(`${insights.watch.length} area${insights.watch.length > 1 ? "s" : ""} require${insights.watch.length === 1 ? "s" : ""} attention — see Watch section below.`);
        if (hasStrong) insights.summary.push(`${insights.strong.length} area${insights.strong.length > 1 ? "s are" : " is"} performing at or above standard — see Strong section below.`);

        return (
          <div>
            {/* Period summary */}
            {insights.summary.length > 0 && (
              <>
                <SL>Period summary — {filterLabel}</SL>
                <div style={{ background: B.black, borderRadius: 10, padding: "16px 20px", marginBottom: 16 }}>
                  {insights.summary.map((s, i) => (
                    <p key={i} style={{ fontSize: 13, color: i === 0 ? B.white : "#aaa", lineHeight: 1.7, marginBottom: i < insights.summary.length - 1 ? 6 : 0 }}>{s}</p>
                  ))}
                </div>
              </>
            )}

            {/* Watch */}
            {insights.watch.length > 0 && (
              <>
                <SL>Watch — needs attention</SL>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                  {insights.watch.map((insight, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, padding: "11px 14px", borderRadius: 8, border: `0.5px solid ${B.border}`, borderLeft: `3px solid ${B.red}`, background: B.white }}>
                      <div style={{ width: 18, height: 18, borderRadius: "50%", background: B.red, color: B.white, fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>!</div>
                      <p style={{ fontSize: 12, color: B.black, lineHeight: 1.6, margin: 0 }}>{insight}</p>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Strong */}
            {insights.strong.length > 0 && (
              <>
                <SL>Strong — performing at standard</SL>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                  {insights.strong.map((insight, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, padding: "11px 14px", borderRadius: 8, border: `0.5px solid ${B.border}`, borderLeft: `3px solid ${B.black}`, background: B.white }}>
                      <div style={{ width: 18, height: 18, borderRadius: "50%", background: B.black, color: B.white, fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>✓</div>
                      <p style={{ fontSize: 12, color: B.black, lineHeight: 1.6, margin: 0 }}>{insight}</p>
                    </div>
                  ))}
                </div>
              </>
            )}

            {insights.watch.length === 0 && insights.strong.length === 0 && (
              <p style={{ fontSize: 12, color: B.charcoal, marginBottom: 20 }}>Not enough data in this window to generate insights. Try a broader date filter.</p>
            )}

            {/* Trend charts */}
            <SL>Audit score — week over week</SL>
            <Card>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={weekTrend} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={B.border} />
                  <XAxis dataKey="week" tick={{ fontSize: 10, fill: B.charcoal }} />
                  <YAxis domain={[50, 100]} tick={{ fontSize: 10, fill: B.charcoal }} />
                  <Tooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="NoMad" stroke={B.red} strokeWidth={2} dot={{ r: 4, fill: B.red }} connectNulls />
                  <Line type="monotone" dataKey="Williamsburg" stroke={B.black} strokeWidth={2} dot={{ r: 4, fill: B.black }} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </Card>

            <SL>PTD vs YTD avg by location</SL>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {["NoMad","Williamsburg"].map(loc => {
                const ptdA = periodAudits.filter(a => a.location === loc);
                const ytdA = ytdAudits.filter(a => a.location === loc);
                return (
                  <div key={loc} style={{ background: B.gray, borderRadius: 8, padding: "12px 14px" }}>
                    <LocBadge loc={loc} />
                    <div style={{ display: "flex", gap: 20, marginTop: 10 }}>
                      <div><div style={{ fontSize: 10, color: B.charcoal }}>PTD avg</div><div style={{ fontSize: 22, fontWeight: 700, color: B.red }}>{avgScore(ptdA)}</div><div style={{ fontSize: 10, color: "#999" }}>{ptdA.length} audit{ptdA.length !== 1 ? "s" : ""}</div></div>
                      <div><div style={{ fontSize: 10, color: B.charcoal }}>YTD avg</div><div style={{ fontSize: 22, fontWeight: 700, color: B.black }}>{avgScore(ytdA)}</div><div style={{ fontSize: 10, color: "#999" }}>{ytdA.length} audit{ytdA.length !== 1 ? "s" : ""}</div></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── NYC STRATEGY METRICS ── */}
      {tab === "nycstrategy" && allAudits.length > 0 && (
        <div>
          <SL>First-Timer Guest Journey (NYC only)</SL>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 14 }}>
            {[
              { label: "Overall pass rate", val: (() => { const r = failRate(filtered, FIRST_TIMER_KEY); return r !== null ? `${100-r}%` : "—"; })(), color: B.red },
              { label: "NoMad pass rate",   val: (() => { const r = failRate(nmAudits, FIRST_TIMER_KEY); return r !== null ? `${100-r}%` : "—"; })(), color: B.red },
              { label: "WB pass rate",      val: (() => { const r = failRate(wbAudits, FIRST_TIMER_KEY); return r !== null ? `${100-r}%` : "—"; })(), color: B.black },
              { label: "Audits scored",     val: `${ftLog.length}`, color: B.black },
            ].map(m => (
              <div key={m.label} style={{ background: B.gray, borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ fontSize: 10, color: B.charcoal, marginBottom: 4 }}>{m.label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: m.color }}>{m.val}</div>
              </div>
            ))}
          </div>
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>Pass rate by week</div>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={ftTrend} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={B.border} />
                <XAxis dataKey="week" tick={{ fontSize: 10, fill: B.charcoal }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: B.charcoal }} unit="%" />
                <Tooltip formatter={v => [`${v}%`,""]} contentStyle={{ fontSize: 11, borderRadius: 6 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="NoMad" stroke={B.red} strokeWidth={2} dot={{ r: 4, fill: B.red }} connectNulls />
                <Line type="monotone" dataKey="Williamsburg" stroke={B.black} strokeWidth={2} dot={{ r: 4, fill: B.black }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </Card>
          <Card style={{ overflow: "hidden", padding: 0, marginBottom: 24 }}>
            <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 60px 60px", padding: "7px 16px", background: B.black, fontSize: 10, fontWeight: 700, color: B.white, textTransform: "uppercase", letterSpacing: "0.07em" }}>
              <span>Date</span><span>Location</span><span style={{ textAlign: "right" }}>Score</span><span style={{ textAlign: "right" }}>Result</span>
            </div>
            {ftLog.map((r, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "100px 1fr 60px 60px", padding: "8px 16px", borderTop: `0.5px solid ${B.border}`, alignItems: "center" }}>
                <span style={{ fontSize: 11.5 }}>{r.date}</span>
                <span><LocBadge loc={r.location} /></span>
                <span style={{ fontSize: 12, fontWeight: 700, color: r.auditScore >= 75 ? B.black : B.red, textAlign: "right" }}>{r.auditScore.toFixed(1)}</span>
                <span style={{ textAlign: "right" }}><PassBadge val={r.result} /></span>
              </div>
            ))}
          </Card>

          <SL>Suggestive Selling during order build</SL>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 14 }}>
            {[
              { label: "Overall pass rate", val: (() => { const r = failRate(filtered, SUGGESTIVE_KEY); return r !== null ? `${100-r}%` : "—"; })(), color: B.red },
              { label: "NoMad pass rate",   val: (() => { const r = failRate(nmAudits, SUGGESTIVE_KEY); return r !== null ? `${100-r}%` : "—"; })(), color: B.red },
              { label: "WB pass rate",      val: (() => { const r = failRate(wbAudits, SUGGESTIVE_KEY); return r !== null ? `${100-r}%` : "—"; })(), color: B.black },
              { label: "Audits scored",     val: `${ssLog.length}`, color: B.black },
            ].map(m => (
              <div key={m.label} style={{ background: B.gray, borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ fontSize: 10, color: B.charcoal, marginBottom: 4 }}>{m.label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: m.color }}>{m.val}</div>
              </div>
            ))}
          </div>
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>Pass rate by week</div>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={ssTrend} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={B.border} />
                <XAxis dataKey="week" tick={{ fontSize: 10, fill: B.charcoal }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: B.charcoal }} unit="%" />
                <Tooltip formatter={v => [`${v}%`,""]} contentStyle={{ fontSize: 11, borderRadius: 6 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="NoMad" stroke={B.red} strokeWidth={2} dot={{ r: 4, fill: B.red }} connectNulls />
                <Line type="monotone" dataKey="Williamsburg" stroke={B.black} strokeWidth={2} dot={{ r: 4, fill: B.black }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </Card>
          <Card style={{ overflow: "hidden", padding: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 60px 60px", padding: "7px 16px", background: B.black, fontSize: 10, fontWeight: 700, color: B.white, textTransform: "uppercase", letterSpacing: "0.07em" }}>
              <span>Date</span><span>Location</span><span style={{ textAlign: "right" }}>Score</span><span style={{ textAlign: "right" }}>Result</span>
            </div>
            {ssLog.map((r, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "100px 1fr 60px 60px", padding: "8px 16px", borderTop: `0.5px solid ${B.border}`, alignItems: "center" }}>
                <span style={{ fontSize: 11.5 }}>{r.date}</span>
                <span><LocBadge loc={r.location} /></span>
                <span style={{ fontSize: 12, fontWeight: 700, color: r.auditScore >= 75 ? B.black : B.red, textAlign: "right" }}>{r.auditScore.toFixed(1)}</span>
                <span style={{ textAlign: "right" }}><PassBadge val={r.result} /></span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
