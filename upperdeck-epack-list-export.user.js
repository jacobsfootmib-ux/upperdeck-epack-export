// ==UserScript==
// @name         Upper Deck e-Pack: CSV Export (DOM Parser + Tooltips + Rarity/Combine/Serial + Rules.json)
// @namespace    epack-export
// @version      1.3.2
// @description  Export e-Pack collection (List view) to CSV using DOM attributes; fills CombineNeeded, Serial, Rarity/Parallel reliably; loads serial denominators from rules.json.
// @match        https://www.upperdeckepack.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL https://raw.githubusercontent.com/jacobsfootmib-ux/upperdeck-epack-export/main/upperdeck-epack-export.user.js
// @updateURL   https://raw.githubusercontent.com/jacobsfootmib-ux/upperdeck-epack-export/main/upperdeck-epack-export.user.js
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------- Config (unchanged scrolling) ----------------------
  const WAIT_MS = 700, IDLE_LIMIT = 12, MAX_PASSES = 5, SCROLL_STEP = 0.9;
  const PHYSICAL_CHECKMARK_MEANS_YES = false;

  // ---------------------- rules.json support (NEW) ----------------------
  // Raw URL to your rules.json in GitHub (use the RAW link)
  const RULES_URL = "https://raw.githubusercontent.com/jacobsfootmib-ux/upperdeck-epack-export/main/rules.json";
  const RULES_CACHE_KEY = "epack_serial_rules_v1";
  const LOCAL_FALLBACK_RULES = {
    version: "fallback",
    display: "unknownNumerator", // "unknownNumerator" → "?/DENOM", "denomOnly" → "/DENOM"
    rules: {
      // Example defaults (safe to keep)
      "2024-25 SP Game Used Hockey|Gold": "149",
      "2024-25 SP Game Used Hockey|Blue": "99",
      "2024-25 SP Game Used Hockey|Green": "25",
      "2024-25 SP Game Used Hockey|Purple": "10",
      "2024-25 SP Game Used Hockey|Black": "1"
    }
  };

  let SERIAL_RULES_REMOTE = null;
  let RULES_CANON_MAP = null;

  const canon = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[®™]/g, "")
      .replace(/\b(base\s*set)\b/g, "")
      .replace(/\s+-\s+/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  function buildCanonMap(rulesObj) {
    const m = new Map();
    const rules = rulesObj?.rules || {};
    for (const [k, v] of Object.entries(rules)) {
      const [setPart, rarityPart = ""] = k.split("|");
      const key = `${canon(setPart)}|${canon(rarityPart)}`;
      m.set(key, String(v).trim());
    }
    return m;
  }

  function loadRulesFromCache() {
    try {
      const raw = localStorage.getItem(RULES_CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj && obj.rules && typeof obj.rules === "object") return obj;
    } catch {}
    return null;
  }

  async function fetchRulesFresh() {
    const url = RULES_URL + (RULES_URL.includes("?") ? "&" : "?") + "_ts=" + Date.now();
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("Rules fetch failed: " + res.status);
    const json = await res.json();
    if (!json || typeof json !== "object" || !json.rules) throw new Error("Bad rules format");
    return json;
  }

  async function ensureRulesLoaded() {
    SERIAL_RULES_REMOTE = loadRulesFromCache();
    try {
      const fresh = await fetchRulesFresh();
      SERIAL_RULES_REMOTE = fresh;
      localStorage.setItem(RULES_CACHE_KEY, JSON.stringify(fresh));
    } catch (e) {
      if (!SERIAL_RULES_REMOTE) SERIAL_RULES_REMOTE = LOCAL_FALLBACK_RULES;
      console.warn("[ePack Export] Using cached/fallback rules:", e);
    }
    RULES_CANON_MAP = buildCanonMap(SERIAL_RULES_REMOTE || LOCAL_FALLBACK_RULES);
  }

  // ---------------------- Rarity helpers (IMPROVED) ----------------------
  // Prefer specific rarities/colors over the generic "Parallel"
  const RARITY_WORDS = [
    // colors / specific first
    "Black Ice","Orange","Magenta","Aquamarine","Purple","Gold","Blue","Green","Red","Silver","Bronze",
    "Emerald","Ruby","Sapphire",
    "Exclusive","Spectrum","Rainbow","Holo","FX","Ice","Neon",
    // families
    "Young Guns","Authentic Rookies","Rookie Sweaters","Banner Year","Net Cord","HOF Marks","Mascot","Canvas",
    "Fabrics","Jersey","Patch","Materials","Die-Cut","Retro","Insert","Legends",
    // generic last
    "Parallel"
  ];
  const RARITY_RX = new RegExp(RARITY_WORDS.join("|").replace(/ /g,"\\s*"), "i");

  // Normalize "gold parallel" → "Gold" (etc.)
  function normalizeRarity(r) {
    const x = (r || "").toLowerCase().replace(/\s+/g, " ").trim();
    const m = x.match(/\b(black|purple|gold|blue|green|red|silver|bronze|orange|magenta|aquamarine|emerald|ruby|sapphire|exclusive|spectrum|rainbow|fx|ice|neon)\b/);
    if (m) return m[1].replace(/^./, c => c.toUpperCase());
    if (/\bparallel\b/.test(x)) return "Parallel";
    return (r || "").trim();
  }

  function inferRarity(set, subset, title) {
    const src = [subset, title, set].map(s => s || "").join(" • ");
    const m = src.match(RARITY_RX);
    return normalizeRarity(m ? m[0].replace(/\s+/g, " ").trim() : "");
  }

  // Remove rarity from set string before rules lookup
  function cleanSetForRules(set, rarity) {
    let s = (set || "");
    const r = normalizeRarity(rarity);
    if (r) s = s.replace(new RegExp("\\b" + r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i"), "");
    s = s.replace(/\bparallel\b/ig, "");
    s = s.replace(/\s+-\s+/g, " ").replace(/\s{2,}/g, " ").trim();
    return s;
  }

  // Serial via rules
  function serialFromRules(set, rarity) {
    if (!RULES_CANON_MAP) return "";
    const rRaw = rarity || "";
    const rNorm = normalizeRarity(rRaw);
    const setClean = cleanSetForRules(set, rNorm);

    const tryKeys = new Set([
      `${canon(setClean)}|${canon(rNorm)}`,  // best: cleaned set + normalized rarity
      `${canon(setClean)}|${canon(rRaw)}`,   // cleaned set + raw rarity
      `${canon(set)}|${canon(rNorm)}`,       // original set + normalized rarity
      `${canon(set)}|${canon(rRaw)}`         // original set + raw rarity
    ]);

    for (const key of tryKeys) {
      const denom = RULES_CANON_MAP.get(key);
      if (denom) {
        const mode = (SERIAL_RULES_REMOTE?.display || LOCAL_FALLBACK_RULES.display || "unknownNumerator");
        return mode === "denomOnly" ? `/${denom}` : `?/${denom}`;
      }
    }
    return "";
  }

  // ---------------------- Original helpers (unchanged) ----------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const asStr = (v) => (v == null ? "" : String(v));
  const isInt = (s) => /^\d+$/.test(asStr(s));
  const hasLetters = (s) => /[A-Za-z]/.test(asStr(s));
  const csvEscape = (v) => {
    const s = asStr(v).replace(/\r?\n|\r/g, " ").trim();
    return /[",]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const getAttr = (el, names) => {
    for (const n of names) {
      const v = el.getAttribute?.(n);
      if (v) return v;
    }
    return "";
  };
  const matchesAny = (text, ...regexes) => regexes.some(rx => rx.test(text));

  function setStatus(txt) {
    let s = document.getElementById("epackExportStatus");
    if (!s) {
      s = document.createElement("div");
      s.id = "epackExportStatus";
      Object.assign(s.style, {
        position: "fixed", right: "16px", bottom: "64px", zIndex: 2147483647,
        background: "rgba(0,0,0,0.75)", color: "#fff", padding: "10px 12px",
        borderRadius: "10px", maxWidth: "420px",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
        fontSize: "13px", lineHeight: "1.3", display: "none", whiteSpace: "pre-wrap",
      });
      document.body.appendChild(s);
    }
    s.textContent = txt || "";
    s.style.display = txt ? "block" : "none";
  }

  function ensureButton() {
    if (document.getElementById("epackExportBtn")) return;
    const btn = document.createElement("button");
    btn.id = "epackExportBtn"; btn.textContent = "Export ePack CSV";
    Object.assign(btn.style, {
      position: "fixed", right: "16px", bottom: "16px", zIndex: 2147483647,
      padding: "10px 14px", borderRadius: "10px", border: "none",
      background: "#1a73e8", color: "#fff", fontWeight: "600",
      boxShadow: "0 4px 14px rgba(0,0,0,0.2)", cursor: "pointer",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    });
    btn.addEventListener("click", runExport);
    document.body.appendChild(btn);
  }

  function isScrollable(el) {
    if (!el) return false;
    const st = getComputedStyle(el);
    return /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 20;
  }
  function findBestScroller() {
    const docEl = document.scrollingElement || document.documentElement;
    if (isScrollable(docEl)) return docEl;
    const candidate = document.querySelector(".content, .main, #root");
    return candidate && isScrollable(candidate) ? candidate : docEl;
  }

  // ---------------------- Infinite scroll loader (unchanged) ----------------------
  async function loadAllByInfiniteScroll() {
    const sc = findBestScroller();
    const sig = () => `${document.querySelectorAll(".group").length}:${sc.scrollHeight}`;
    let prev = "";
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      let idle = 0, last = "";
      setStatus(`Loading cards… pass ${pass}/${MAX_PASSES}`);
      for (;;) {
        const target = Math.floor(sc.scrollHeight * SCROLL_STEP);
        sc.scrollTo({ top: target, behavior: "instant" });
        sc.scrollTop = sc.scrollHeight;
        await sleep(WAIT_MS);
        const now = sig();
        if (now === last) { if (++idle >= IDLE_LIMIT) break; }
        else { idle = 0; last = now; }
      }
      const now2 = sig();
      if (now2 === prev) break;
      prev = now2;
      sc.scrollTop = Math.max(0, sc.scrollTop - sc.clientHeight);
      await sleep(WAIT_MS);
    }
    setStatus("Finalizing load…");
    sc.scrollTop = sc.scrollHeight;
    await sleep(WAIT_MS * 2);
  }

  // ---------------------- Keys & parsing (unchanged core) ----------------------
  const KEYS = {
    qty: /qty\s*owned/i,
    subj: /subject\s*points?/i,
    combine: /(combine|qty\s*needed\s*to\s*combine|needed\s*to\s*combine|to\s*combine|combine\s*needed|pieces\s*needed)/i,
    physical: /physical/i,
    locked: /locked/i,
    wishlist: /wishlist|heart/i,
    serial: /serial|numbered/i
  };

  function findRowContainer(el, stopEl) {
    // Climb until a plausible row container
    while (el && el !== stopEl && el !== document.body) {
      const role = el.getAttribute?.("role") || "";
      const cls = el.className ? String(el.className) : "";
      const tag = el.tagName || "";
      if (
        role === "row" ||
        /(^|\s)(row|group-item|item|card|list-row|collection-row)(\s|$)/i.test(cls) ||
        tag === "LI" || tag === "TR"
      ) return el;
      el = el.parentElement;
    }
    return null;
  }

  function tokensFromRow(rowEl) {
    const toks = [];
    const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || "").trim();
      if (t) t.split("\n").map(s => s.trim()).filter(Boolean).forEach(s => toks.push(s));
    }
    return toks;
  }

  // Try multiple ways to get a metric by tooltip/aria/title
  function getByKeyFromEls(els, rxKey) {
    const el = els.find(e => matchesAny(
      (getAttr(e, ["data-tooltip","aria-label","title"]) || ""), rxKey
    ));
    if (!el) return null;
    const txt = (el.textContent || "").trim();
    if (txt) return txt;
    const fallback = getAttr(el, ["data-value","data-count"]) || "";
    return fallback || null;
  }

  // Build one card row from a qty span anchor
  function rowFromQtySpan(qtySpan, groupEl) {
    const rowEl = findRowContainer(qtySpan, groupEl) || qtySpan.closest("*");
    if (!rowEl) return null;

    const toks = tokensFromRow(rowEl);
    // Card # = first pure integer; Title = next token with letters
    let cardNo = "", title = "", titleIndex = -1;
    for (let i=0;i<toks.length;i++) {
      if (isInt(toks[i])) {
        cardNo = toks[i];
        for (let j=i+1;j<toks.length;j++) {
          if (hasLetters(toks[j])) { title = toks[j]; titleIndex = j; break; }
        }
        break;
      }
    }

    const allEls = Array.from(rowEl.querySelectorAll("*"));

    let qtyTxt  = getByKeyFromEls(allEls, KEYS.qty);
    let subjTxt = getByKeyFromEls(allEls, KEYS.subj);
    let combTxt = getByKeyFromEls(allEls, KEYS.combine);

    // fallback: three numbers after title = [qty, subj, combine]
    if (titleIndex >= 0) {
      const after = toks.slice(titleIndex + 1);
      const nums = [];
      for (let k = 0; k < after.length; k++) {
        if (/^\d+$/.test(after[k])) nums.push(after[k]);
        if (nums.length === 3) break;
      }
      if (!qtyTxt  && nums[0] != null) qtyTxt  = String(nums[0]);
      if (!subjTxt && nums[1] != null) subjTxt = String(nums[1]);
      if (!combTxt && nums[2] != null) combTxt = String(nums[2]);
    }
    if (!qtyTxt)  qtyTxt  = "0";
    if (!subjTxt) subjTxt = "0";
    if (!combTxt) combTxt = "0";

    const physEl = allEls.find(e => matchesAny(getAttr(e, ["data-tooltip","aria-label","title"]) || "", KEYS.physical));
    const lockEl = allEls.find(e => matchesAny(getAttr(e, ["data-tooltip","aria-label","title"]) || "", KEYS.locked));
    const wishEl = allEls.find(e => matchesAny(getAttr(e, ["data-tooltip","aria-label","title"]) || "", KEYS.wishlist));

    // Normalize Physical
    let physical = "No";
    if (physEl) {
      const al = (getAttr(physEl, ["aria-label","data-tooltip","title"]) || "").toLowerCase();
      const txt = (physEl.textContent || "").trim();
      if (/pending/.test(al) || /pending/.test(txt)) physical = "Pending";
      else if (/yes|green/.test(al)) physical = "Yes";
      else if (txt === "✓") physical = PHYSICAL_CHECKMARK_MEANS_YES ? "Yes" : "No";
    }

    // Locked normalize
    let locked = "No";
    if (lockEl) {
      const al = (getAttr(lockEl, ["aria-label","data-tooltip","title"]) || "").toLowerCase();
      const txt = (lockEl.textContent || "").trim();
      if (/locked/.test(al) && /on|yes|true|1/.test(al)) locked = "Yes";
      else if (/unlock/.test(al)) locked = "No";
      else if (txt === "1") locked = "Yes";
      else if (txt === "0") locked = "No";
    }

    // Wishlist normalize
    let wishlist = "No";
    if (wishEl) {
      const al = (getAttr(wishEl, ["aria-label","data-tooltip","title"]) || "").toLowerCase();
      const cls = (wishEl.className || "").toLowerCase();
      const txt = (wishEl.textContent || "").trim();
      if (/remove.*wishlist|wishlisted|on|true|filled/.test(al) || /active|filled/.test(cls) || /♥/.test(txt)) {
        wishlist = "Yes";
      }
    }

    // Numeric cleanup
    const toInt = (x) => {
      const m = asStr(x).match(/\d+/);
      return m ? parseInt(m[0], 10) : 0;
    };
    const qty = toInt(qtyTxt);
    const subjPoints = toInt(subjTxt);
    const combineNeed = toInt(combTxt);

    // Serial: try attributes first, then text
    let serial = "";
    const serialEl = allEls.find(e => matchesAny(getAttr(e, ["data-tooltip","aria-label","title"]) || "", KEYS.serial));
    if (serialEl) {
      const srctxt = (serialEl.textContent || getAttr(serialEl, ["data-value","title"]) || "").trim();
      const m = srctxt.match(/#\s*\d+\s*\/\s*\d+\b|#\s*\d+\s*\/\s*1\b/i);
      if (m) serial = m[0].replace(/\s+/g,"");
    }
    if (!serial) {
      const rowText = (rowEl.textContent || "").replace(/\s+/g," ");
      const m2 = rowText.match(/#\s*\d+\s*\/\s*\d+\b|#\s*\d+\s*\/\s*1\b/i);
      if (m2) serial = m2[0].replace(/\s+/g,"");
    }

    const raw = (rowEl.textContent || "").replace(/\s+\n/g, " ").replace(/\s{2,}/g," ").trim();
    return { rowEl, cardNo, title, qty, subjPoints, combineNeed, physical, locked, wishlist, serial, raw };
  }

  // ---------------------- Group parsing (kept, but header-aware for rules) ----------------------
  function parseGroup(groupEl) {
    // Original header extraction: tokens up to first number
    const allTextTokens = (groupEl.innerText || "").split("\n").map(s => s.trim()).filter(Boolean);
    let h = 0; while (h < allTextTokens.length && !isInt(allTextTokens[h])) h++;
    const header = allTextTokens.slice(0, h).join(" "); // e.g., "2024-25 SP Game Used Hockey Gold Parallel - Legends"

    // Split set/subset like before
    let set = header, subset = "";
    if (set.includes(" - ")) {
      const parts = set.split(" - ");
      set = parts.shift().trim();
      subset = parts.join(" - ").trim();
    }
    const seasonMatch = set.match(/\b(20\d{2}|19\d{2})(?:-\d{2})?\b/);
    const year = seasonMatch ? seasonMatch[0] : "";

    // Infer rarity from the full header (captures "Gold Parallel" cases)
    const rarity = inferRarity(header, subset, "");

    // Find rows by Qty tooltip (unchanged)
    const qtySpans = Array.from(groupEl.querySelectorAll('[data-tooltip]'))
      .filter(el => KEYS.qty.test(el.getAttribute('data-tooltip') || ""));

    const rows = [];
    const seen = new Set();
    for (const q of qtySpans) {
      const r = rowFromQtySpan(q, groupEl);
      if (!r) continue;
      if (!r.cardNo || !r.title) continue;
      if (seen.has(r.rowEl)) continue;
      seen.add(r.rowEl);

      // Serial: prefer DOM; else compute via rules with cleaned set
      let serialOut = r.serial;
      if (!serialOut) {
        const byRule = serialFromRules(set, rarity); // set may contain "Gold Parallel"; serialFromRules cleans it
        if (byRule) serialOut = byRule;
      }

      rows.push({
        Title: r.title,
        Set: set,                    // keep as displayed (may include "Gold Parallel")
        "Subset/Insert": subset,
        "Card #": r.cardNo,
        Year: year,
        "Rarity/Parallel": rarity,
        Qty: r.qty,
        SubjPoints: r.subjPoints,
        CombineNeeded: r.combineNeed,
        Physical: r.physical,
        Locked: r.locked,
        Wishlist: r.wishlist,
        Serial: serialOut,
        RawText: `${header} | ${r.raw}`
      });
    }

    return rows;
  }

  // ---------------------- CSV writer (unchanged) ----------------------
  function downloadCSV(rows) {
    const headers = [
      "Title","Set","Subset/Insert","Card #","Year","Rarity/Parallel",
      "Qty","SubjPoints","CombineNeeded","Physical","Locked","Wishlist","Serial","RawText"
    ];
    const lines = [headers.join(",")];
    for (const r of rows) lines.push(headers.map(h => csvEscape(r[h] ?? "")).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `epack_collection_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------------------- Orchestrator (unchanged scroll) ----------------------
  async function runExport() {
    const btn = document.getElementById("epackExportBtn");
    try {
      btn.disabled = true; btn.textContent = "Exporting…"; setStatus("Loading rules…");
      await ensureRulesLoaded();

      setStatus("Scrolling collection…");
      await loadAllByInfiniteScroll();

      const groups = Array.from(document.querySelectorAll(".group"));
      if (!groups.length) { alert("No '.group' sections found—switch to List view"); return; }

      setStatus(`Parsing ${groups.length} groups…`);
      const items = groups.flatMap(parseGroup);
      if (!items.length) { alert("No cards parsed—layout may differ."); return; }

      downloadCSV(items);
      setStatus(`Exported ${items.length} rows ✓`);
    } catch (e) {
      console.error(e);
      alert("Export failed—see console for details.");
    } finally {
      btn.disabled = false; btn.textContent = "Export ePack CSV";
      setTimeout(() => setStatus(""), 5000);
    }
  }

  new MutationObserver(() => ensureButton()).observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();
})();
