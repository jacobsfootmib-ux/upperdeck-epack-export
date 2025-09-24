// ==UserScript==
// @name         Upper Deck e-Pack: List-View CSV Export (Group Parser)
// @namespace    https://github.com/<jacobsfootmib-ux>/upperdeck-epack-export
// @version      1.0.0
// @description  Export e-Pack collection from List view (.group) to CSV
// @match        https://www.upperdeckepack.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/<jacobsfootmib-ux>/upperdeck-epack-export/main/upperdeck-epack-list-export.user.js
// @downloadURL  https://raw.githubusercontent.com/<jacobsfootmib-ux>/upperdeck-epack-export/main/upperdeck-epack-list-export.user.js
// ==/UserScript==

(function () {
  "use strict";

  // ---------- UI ----------
  function ensureButton() {
    if (document.getElementById("epackExportBtn")) return;
    const btn = document.createElement("button");
    btn.id = "epackExportBtn";
    btn.textContent = "Export ePack CSV";
    Object.assign(btn.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: 2147483647,
      padding: "10px 14px",
      borderRadius: "10px",
      border: "none",
      background: "#1a73e8",
      color: "#fff",
      fontWeight: "600",
      boxShadow: "0 4px 14px rgba(0,0,0,0.2)",
      cursor: "pointer",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    });
    btn.addEventListener("click", runExport);
    (document.body || document.documentElement).appendChild(btn);

    // status toast
    if (!document.getElementById("epackExportStatus")) {
      const s = document.createElement("div");
      s.id = "epackExportStatus";
      Object.assign(s.style, {
        position: "fixed",
        right: "16px",
        bottom: "64px",
        zIndex: 2147483647,
        background: "rgba(0,0,0,0.75)",
        color: "#fff",
        padding: "10px 12px",
        borderRadius: "10px",
        maxWidth: "360px",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
        fontSize: "13px",
        lineHeight: "1.3",
        display: "none",
        whiteSpace: "pre-wrap",
      });
      (document.body || document.documentElement).appendChild(s);
    }
  }
  function setStatus(txt) {
    const s = document.getElementById("epackExportStatus");
    if (!s) return;
    s.textContent = txt;
    s.style.display = txt ? "block" : "none";
  }

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function csvEscape(v) {
    if (v == null) return "";
    const s = String(v).replace(/\r?\n|\r/g, " ").trim();
    return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function isScrollable(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const st = getComputedStyle(el);
    return /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 20;
  }
  function biggestScroller() {
    const docEl = document.scrollingElement || document.documentElement;
    let best = docEl, bestArea = docEl.clientWidth * docEl.clientHeight;
    document.querySelectorAll("*").forEach((el) => {
      try {
        if (isScrollable(el)) {
          const area = el.clientWidth * el.clientHeight;
          if (area > bestArea) { best = el; bestArea = area; }
        }
      } catch (_) {}
    });
    return best;
  }

  // ---------- scrolling + parsing ----------
  async function scrollAllGroups() {
    const sc = biggestScroller();
    let prev = 0, idle = 0;
    while (idle < 6) {
      sc.scrollTo(0, sc.scrollHeight);
      await sleep(900);
      const now = document.querySelectorAll(".group").length;
      if (now > prev) { prev = now; idle = 0; setStatus(`Loading groups… (${now} visible)`); }
      else idle++;
    }
  }

  // Parse a .group section:
  // Header lines until first pure number; then repeating blocks of:
  // [card #] → [title line] → [detail lines] → next [card #]
  function parseGroup(groupEl) {
    const lines = (groupEl.innerText || "")
      .split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return [];

    let firstNumIdx = lines.findIndex((s) => /^\d+$/.test(s));
    if (firstNumIdx === -1) firstNumIdx = lines.length;

    const header = lines.slice(0, firstNumIdx).join(" ");
    let set = header, subset = "";
    const dashIdx = header.indexOf(" - ");
    if (dashIdx !== -1) {
      set = header.slice(0, dashIdx).trim();
      subset = header.slice(dashIdx + 3).trim();
    }

    const out = [];
    let i = firstNumIdx;
    while (i < lines.length) {
      if (!/^\d+$/.test(lines[i])) { i++; continue; }
      const cardNo = lines[i]; i++;

      // Find a plausible title (next non-numeric, non-✓ line)
      let title = "";
      while (i < lines.length) {
        const s = lines[i];
        if (/[a-z]/i.test(s) && !/^\d+$/.test(s) && s !== "✓") { title = s; i++; break; }
        i++;
      }

      // Details until next numeric card number
      const detailStart = i;
      while (i < lines.length && !/^\d+$/.test(lines[i])) i++;
      const details = lines.slice(detailStart, i);

      const qty = (details.find((t) => /^\d+$/.test(t)) || "") || "";
      const serial = ((details.join(" ").match(/#\s*\d+\s*\/\s*\d+/) || [""])[0] || "").replace(/\s+/g, "");
      const rarity = details.find((s) =>
        /(Parallel|Gold|Blue|Green|Red|Canvas|Retro|FX|Exclusive|Auto|Patch|Die-?Cut|Spectrum|Rainbow)/i.test(s)
      ) || "";
      const yearMatch = set.match(/\b(20\d{2}|19\d{2})\b/);
      const year = yearMatch ? yearMatch[1] : "";

      out.push({
        title,
        set,
        subset_or_insert: subset,
        card_number: cardNo,
        year,
        rarity_or_parallel: rarity,
        quantity: qty,
        serial,
        raw: `${header} | ${details.join(" | ")}`,
      });
    }
    return out;
  }

  function downloadCSV(rows) {
    const headers = [
      "Title","Set","Subset/Insert","Card #","Year",
      "Rarity/Parallel","Quantity","Serial","RawText"
    ];
    const lines = [headers.join(",")];
    for (const r of rows) {
      lines.push([
        r.title, r.set, r.subset_or_insert, r.card_number, r.year,
        r.rarity_or_parallel, r.quantity, r.serial, r.raw
      ].map(csvEscape).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `epack_collection_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  async function runExport() {
    const btn = document.getElementById("epackExportBtn");
    try {
      if (btn) { btn.disabled = true; btn.textContent = "Exporting…"; }
      setStatus("Scanning list view groups…");
      await scrollAllGroups();

      const groups = Array.from(document.querySelectorAll(".group"));
      if (!groups.length) { setStatus("No '.group' sections found—are you in List view?"); alert("No '.group' sections found."); return; }

      setStatus(`Parsing ${groups.length} groups…`);
      const items = groups.flatMap(parseGroup).filter((r) => r.title || r.card_number);
      if (!items.length) { setStatus("Parsed groups but found 0 cards—layout changed?"); alert("No cards parsed—layout may differ."); return; }

      downloadCSV(items);
      setStatus(`Exported ${items.length} rows ✓`);
    } catch (e) {
      console.error(e);
      setStatus("Export failed—see console for details.");
      alert("Export failed. See console for details.");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Export ePack CSV"; }
      setTimeout(() => setStatus(""), 4000);
    }
  }

  // Keep the button present even if the SPA rerenders the page
  const obs = new MutationObserver(() => ensureButton());
  obs.observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();
})();
