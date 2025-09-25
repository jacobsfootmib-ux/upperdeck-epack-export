// ==UserScript==
// @name         Upper Deck e-Pack: CSV Export (Collection + Checklist; Remote Serial Rules)
// @namespace    https://github.com/jacobsfootmib-ux/upperdeck-epack-export
// @version      1.5.0
// @description  Export e-Pack Collection (DOM tooltips) and Checklist (rules-only) to CSV; Serial via community-hosted rules.json.
// @author       jacobsfootmib-ux
// @license      MIT
// @homepageURL  https://github.com/jacobsfootmib-ux/upperdeck-epack-export
// @supportURL   https://github.com/jacobsfootmib-ux/upperdeck-epack-export/issues
// @downloadURL  https://raw.githubusercontent.com/jacobsfootmib-ux/upperdeck-epack-export/main/upperdeck-epack-export.user.js
// @updateURL    https://raw.githubusercontent.com/jacobsfootmib-ux/upperdeck-epack-export/main/upperdeck-epack-export.user.js
// @match        https://www.upperdeckepack.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // ========= Remote rules config =========
  // Make sure this points to the RAW file URL of rules.json in the repo:
  const RULES_URL = "https://raw.githubusercontent.com/jacobsfootmib-ux/upperdeck-epack-export/main/rules.json";
  const RULES_CACHE_KEY = "epack_serial_rules_v1";
  // =======================================

  // ---------------------- Shared behavior toggles ----------------------
  const WAIT_MS = 700, IDLE_LIMIT = 12, MAX_PASSES = 5, SCROLL_STEP = 0.9;
  const PHYSICAL_CHECKMARK_MEANS_YES = false;

  // Tooltip/aria matching (case-insensitive)
  const KEYS = {
    qty: /qty\s*owned/i,
    subj: /subject\s*points?/i,
    combine: /(combine|qty\s*needed\s*to\s*combine|needed\s*to\s*combine|to\s*combine|combine\s*needed|pieces\s*needed)/i,
    physical: /physical/i,
    locked: /locked/i,
    wishlist: /wishlist|heart/i,
    serial: /serial|numbered/i,
  };

  // Rarity/Parallel keyword inference (expand as needed)
  const RARITY_WORDS = [
    "Young Guns","Canvas","Fabrics","Retro","Insert","Parallel","Legends",
    "Authentic Rookies","Checklist","Spectrum","Rainbow","Gold","Blue","Green","Red",
    "Exclusive","FX","Ice","Debut","Rookie","Jersey","Materials","Patch","Die-Cut",
    "HOF Marks","Banner Year","Net Cord","New Grooves","Rookie Sweaters","All-Star","Mascot",
    "Black","Purple","Orange","Teal","Silver","Bronze"
  ];
  const RARITY_RX = new RegExp(RARITY_WORDS.join("|").replace(/ /g,"\\s*"), "i");

  // ---------------------- Local fallback rules ----------------------
  const LOCAL_FALLBACK_RULES = {
    version: "fallback",
    display: "unknownNumerator", // "unknownNumerator" => "?/DENOM", "denomOnly" => "/DENOM"
    rules: {
      // Seed examples; community will extend in rules.json
      "2024-25 SP Game Used Hockey|Gold": "149",
      "2024-25 SP Game Used Hockey|Blue": "99",
      "2024-25 SP Game Used Hockey|Green": "25",
      "2024-25 SP Game Used Hockey|Purple": "10",
      "2024-25 SP Game Used Hockey|Black": "1"
    }
  };

  // ---------------------- Remote rules state ----------------------
  let SERIAL_RULES_REMOTE = null; // {version, display, rules:{ "set|rarity": "denom", ... }}

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
  }

  // ---------------------- Utils ----------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const asStr = (v) => (v == null ? "" : String(v));
  const isInt = (s) => /^\d+$/.test(asStr(s));
  const hasLetters = (s) => /[A-Za-z]/.test(asStr(s));
  const csvEscape = (v) => {
    const s = asStr(v).replace(/\r?\n|\r/g, " ").trim();
    return /[",]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const getAttr = (el, names) => {
    for (const n of names) { const v = el.getAttribute?.(n); if (v) return v; }
    return "";
  };
  const matchesAny = (text, ...regexes) => regexes.some(rx => rx.test(text));
  const normKey = (set, rarity) => `${asStr(set).trim().toLowerCase()}|${asStr(rarity).trim().toLowerCase()}`;

  // ---------------------- UI helpers ----------------------
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

  // ---------------------- Scrolling (Collection mode) ----------------------
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

  // ---------------------- Mode detection ----------------------
  function isChecklistPage() {
    const url = location.pathname.toLowerCase();
    if (url.includes("/checklist")) return true;
    if (document.querySelector('[data-page="checklist"], .checklist, .check-list, [data-checklist]')) return true;
    const bodyText = (document.body.innerText || "").toLowerCase();
    if (/checklist/.test(bodyText) && !/my collection|qty owned/i.test(bodyText)) return true;
    return false;
  }

  // ---------------------- Collection-mode helpers ----------------------
  function findRowContainer(el, stopEl) {
    while (el && el !== stopEl && el !== document.body) {
      const role = el.getAttribute?.("role") || "";
      const cls = el.className ? String(el.className) : "";
      const tag = el.tagName || "";
      if (role === "row" ||
          /(^|\s)(row|group-item|item|card|list-row|collection-row)(\s|$)/i.test(cls) ||
          tag === "LI" || tag === "TR") return el;
      el = el.parentElement;
    }
    return null;
  }

  function tokensFromNode(root, show = NodeFilter.SHOW_TEXT) {
    const out = [];
    const walker = document.createTreeWalker(root, show, null);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || "").trim();
      if (t) t.split("\n").map(s => s.trim()).filter(Boolean).forEach(s => out.push(s));
    }
    return out;
  }

  function getByKeyFromEls(els, rxKey) {
    const el = els.find(e => matchesAny((getAttr(e, ["data-tooltip","aria-label","title"]) || ""), rxKey));
    if (!el) return null;
    const txt = (el.textContent || "").trim();
    if (txt) return txt;
    const fallback = getAttr(el, ["data-value","data-count"]) || "";
    return fallback || null;
  }

  function inferRarity(set, subset, title) {
    const src = [subset, title, set].map(asStr).join(" • ");
    const m = src.match(RARITY_RX);
    return m ? m[0].replace(/\s+/g, " ").trim() : "";
  }

  function serialFromRules(set, rarity) {
    const rulesObj = SERIAL_RULES_REMOTE || LOCAL_FALLBACK_RULES;
    if (!set || !rarity || !rulesObj || !rulesObj.rules) return "";
    const key = normKey(set, rarity);
    const hit = Object.entries(rulesObj.rules).find(([k]) => k.trim().toLowerCase() === key);
    if (!hit) return "";
    const denom = String(hit[1]).trim();
    const displayMode = (rulesObj.display || "unknownNumerator");
    return displayMode === "denomOnly" ? `/${denom}` : `?/${denom}`;
  }

  function rowFromQtySpan(qtySpan, groupEl) {
    const rowEl = findRowContainer(qtySpan, groupEl) || qtySpan.closest("*");
    if (!rowEl) return null;

    const toks = tokensFromNode(rowEl);
    // Card # = first pure integer; Title = next token with letters
    let cardNo = "", title = "";
    for (let i=0;i<toks.length;i++) {
      if (isInt(toks[i])) {
        cardNo = toks[i];
        for (let j=i+1;j<toks.length;j++) {
          if (hasLetters(toks[j])) { title = toks[j]; break; }
        }
        break;
      }
    }

    const allEls = Array.from(rowEl.querySelectorAll("*"));
    const qtyTxt  = getByKeyFromEls(allEls, KEYS.qty);
    const subjTxt = getByKeyFromEls(allEls, KEYS.subj);
    let combTxt   = getByKeyFromEls(allEls, KEYS.combine);
    if (combTxt == null || combTxt === "") {
      // fall back to 0 when not combinable
      combTxt = "0";
    }

    // (Physical/Locked/Wishlist often icon-only; skip unless needed)
    // Normalize numeric fields
    const toInt = (x) => {
      const m = asStr(x).match(/\d+/);
      return m ? parseInt(m[0], 10) : "";
    };

    const qty = toInt(qtyTxt);
    const subjPoints = toInt(subjTxt);
    const combineNeed = toInt(combTxt);

    const raw = (rowEl.textContent || "").replace(/\s+\n/g, " ").replace(/\s{2,}/g," ").trim();
    return { rowEl, cardNo, title, qty, subjPoints, combineNeed, raw };
  }

  function parseGroupsCollection() {
    const groups = Array.from(document.querySelectorAll(".group"));
    if (!groups.length) return [];

    const rowsOut = [];
    for (const groupEl of groups) {
      // Header = set/subset from the top part before the first number
      const allTextTokens = (groupEl.innerText || "").split("\n").map(s => s.trim()).filter(Boolean);
      let h = 0; while (h < allTextTokens.length && !isInt(allTextTokens[h])) h++;
      const header = allTextTokens.slice(0, h).join(" ");
      let set = header, subset = "";
      if (set.includes(" - ")) {
        const parts = set.split(" - ");
        set = parts.shift().trim();
        subset = parts.join(" - ").trim();
      }
      const seasonMatch = set.match(/\b(20\d{2}|19\d{2})(?:-\d{2})?\b/);
      const year = seasonMatch ? seasonMatch[0] : "";

      // Find row anchors via Qty tooltip
      const qtySpans = Array.from(groupEl.querySelectorAll('[data-tooltip]'))
        .filter(el => KEYS.qty.test(el.getAttribute('data-tooltip') || ""));

      const seen = new Set();
      for (const q of qtySpans) {
        const r = rowFromQtySpan(q, groupEl);
        if (!r) continue;
        if (!r.cardNo || !r.title) continue;
        if (seen.has(r.rowEl)) continue;
        seen.add(r.rowEl);

        const rarity = inferRarity(set, subset, r.title);
        const serialByRule = serialFromRules(set, rarity);

        rowsOut.push({
          Title: r.title,
          Set: set,
          "Subset/Insert": subset,
          "Card #": r.cardNo,
          Year: year,
          "Rarity/Parallel": rarity,
          Qty: r.qty,
          SubjPoints: r.subjPoints,
          CombineNeeded: r.combineNeed,
          Physical: "",   // icon-only in many cases; omitted in collection mode export for stability
          Locked: "",
          Wishlist: "",
          Serial: serialByRule, // rules-based (no OCR here)
          RawText: `${set}${subset?(" - "+subset):""} | ${r.raw}`
        });
      }
    }
    return rowsOut;
  }

  // ---------------------- Checklist-mode parsing (rules-only) ----------------------
  function guessGroupsChecklist() {
    // Try obvious containers; fallback is broad content blocks
    const candidates = Array.from(document.querySelectorAll(
      ".group, .checklist-group, section, .accordion, .list, .cards, .content"
    ));
    return candidates.filter(el => (el.innerText || "").split("\n").filter(Boolean).length > 10);
  }

  function extractHeaderFromGroup(groupEl) {
    const toks = tokensFromNode(groupEl, NodeFilter.SHOW_TEXT);
    let h = 0; while (h < toks.length && !/^\d+$/.test(toks[h])) h++;
    const header = toks.slice(0, h).join(" ").replace(/\s{2,}/g," ").trim();
    let set = header, subset = "";
    if (set.includes(" - ")) {
      const parts = set.split(" - ");
      set = parts.shift().trim();
      subset = parts.join(" - ").trim();
    }
    const seasonMatch = set.match(/\b(20\d{2}|19\d{2})(?:-\d{2})?\b/);
    const year = seasonMatch ? seasonMatch[0] : "";
    return { set, subset, year };
  }

  function findChecklistRowCandidates(groupEl) {
    // Prefer structured rows first
    let rows = Array.from(groupEl.querySelectorAll('[role="row"], li, tr, .row, .checklist-item, .item'));
    if (!rows.length) rows = Array.from(groupEl.children);
    return rows;
  }

  function parseChecklistRow(rowEl) {
    const toks = tokensFromNode(rowEl);
    // Card # = first pure integer; Title = next token with letters
    let cardNo = "", title = "";
    for (let i=0;i<toks.length;i++) {
      if (/^\d+$/.test(toks[i])) {
        cardNo = toks[i];
        for (let j=i+1;j<toks.length;j++) {
          if (/[A-Za-z]/.test(toks[j])) { title = toks[j]; break; }
        }
        break;
      }
    }
    // Fallback: title as rest of the line after cardNo
    if (!title && cardNo) {
      const after = toks.slice(toks.findIndex(t => t===cardNo)+1).join(" ").trim();
      const m = after.match(/[A-Za-z].*$/);
      if (m) title = m[0].trim();
    }
    const raw = (rowEl.innerText || "").replace(/\s+\n/g," ").replace(/\s{2,}/g," ").trim();
    return { cardNo, title, raw };
  }

  function parseGroupsChecklist() {
    const groups = guessGroupsChecklist();
    if (!groups.length) return [];

    const out = [];
    for (const groupEl of groups) {
      const { set, subset, year } = extractHeaderFromGroup(groupEl);
      const rowEls = findChecklistRowCandidates(groupEl).filter(el => (el.innerText || "").trim().length > 10);

      const seenRows = new Set();
      for (const rowEl of rowEls) {
        const { cardNo, title, raw } = parseChecklistRow(rowEl);
        if (!cardNo || !title) continue;
        if (seenRows.has(rowEl)) continue; // avoid dup
        seenRows.add(rowEl);

        // Infer rarity from set/subset/title text
        const rarity = (function() {
          const src = [subset, title, set].join(" • ");
          const m = src.match(RARITY_RX);
          return m ? m[0].replace(/\s+/g," ").trim() : "";
        })();

        const serialByRule = serialFromRules(set, rarity);

        out.push({
          Title: title,
          Set: set,
          "Subset/Insert": subset,
          "Card #": cardNo,
          Year: year,
          "Rarity/Parallel": rarity,
          Qty: "",            // not shown in checklist
          SubjPoints: "",
          CombineNeeded: "0", // reasonable default; checklist rarely lists this
          Physical: "",
          Locked: "",
          Wishlist: "",
          Serial: serialByRule, // rules-only
          RawText: `${set}${subset?(" - "+subset):""} | ${raw}`
        });
      }
    }
    return out;
  }

  // ---------------------- CSV writer ----------------------
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
    a.download = `epack_${isChecklistPage() ? "checklist" : "collection"}_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------------------- Orchestrator ----------------------
  async function runExport() {
    const btn = document.getElementById("epackExportBtn");
    try {
      btn.disabled = true;
      btn.textContent = "Exporting…";
      setStatus("Fetching rules…");
      await ensureRulesLoaded();

      const checklist = isChecklistPage();

      if (!checklist) {
        setStatus("Scrolling collection…");
        await loadAllByInfiniteScroll();
      }

      setStatus(`Parsing ${checklist ? "checklist" : "collection"}…`);
      const items = checklist ? parseGroupsChecklist() : parseGroupsCollection();

      if (!items.length) {
        alert(`No cards parsed in ${checklist ? "checklist" : "collection"} view—try switching views and re-run.`);
        return;
      }

      downloadCSV(items);
      setStatus(`Exported ${items.length} rows ✓`);
    } catch (e) {
      console.error(e);
      alert("Export failed—see console for details.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Export ePack CSV";
      setTimeout(() => setStatus(""), 5000);
    }
  }

  new MutationObserver(() => {
    if (!document.getElementById("epackExportBtn")) ensureButton();
  }).observe(document.documentElement, { childList: true, subtree: true });

  ensureButton();
})();

