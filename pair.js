/* Vokabelkasten – turns OCR words (with positions) into vocabulary pairs.
   Works on columns of whitespace: finds the vertical gaps that separate the
   columns of a vocabulary list, drops phonetic transcriptions, and puts the
   German column on the right. Pure function, no browser APIs. */
(function (root) {
  const IPA = /[ˈˌəɪʊæðθʃʒŋɔːɑɜʌɒɐ]/;
  const JUNK = /^[|_\-–—=:;.,•·*~»«"'()]+$/;
  const DE_WORDS = /\b(der|die|das|den|dem|des|ein|eine|einen|einem|sich|etw|jdn|jdm|jds|und|zu|von|mit|nicht|ist|sein|haben|werden|auf|aus|für|bei)\b/i;
  const DE_CHARS = /[äöüß]/i;

  const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  /* words: [{text, conf, x0, y0, x1, y1}] in image pixels.
     angle: page tilt in radians (from the OCR baselines); positions are
     straightened with it before words are grouped into rows. */
  function groupRows(words, angle = 0) {
    const t = Math.tan(angle || 0);
    const ws = words
      .map(w => {
        const cx = (w.x0 + w.x1) / 2, dy = cx * t;
        return { ...w, text: String(w.text || "").trim(), cy: (w.y0 + w.y1) / 2 - dy, ty0: w.y0 - dy, ty1: w.y1 - dy, h: w.y1 - w.y0 };
      })
      .filter(w => w.text && !JUNK.test(w.text) && w.h > 0)
      .sort((a, b) => a.cy - b.cy);
    const hMed = median(ws.map(w => w.h)) || 10;
    const rows = [];
    for (const w of ws) {
      // join the open row whose vertical band overlaps this word enough
      let best = null, bestOv = 0;
      for (let i = rows.length - 1; i >= 0 && i >= rows.length - 3; i--) {
        const r = rows[i];
        const ov = Math.min(r.y1, w.ty1) - Math.max(r.y0, w.ty0);
        const need = Math.min(r.y1 - r.y0, w.ty1 - w.ty0) * 0.4;
        if (ov > need && ov > bestOv && Math.abs(w.cy - r.cy) < hMed * 0.9) { best = r; bestOv = ov; }
      }
      if (best) {
        best.words.push(w);
        best.cy = best.words.reduce((s, x) => s + x.cy, 0) / best.words.length;
        best.y0 = median(best.words.map(x => x.ty0)); best.y1 = median(best.words.map(x => x.ty1));
      } else rows.push({ cy: w.cy, y0: w.ty0, y1: w.ty1, words: [w] });
    }
    rows.sort((a, b) => a.cy - b.cy);
    for (const r of rows) r.words.sort((a, b) => a.x0 - b.x0);
    return { rows, hMed };
  }

  /* page tilt from OCR line baselines: [{x0,y0,x1,y1}] */
  function tiltFromBaselines(lines) {
    const angles = (lines || [])
      .filter(b => b && b.x1 - b.x0 > 60)
      .map(b => Math.atan2(b.y1 - b.y0, b.x1 - b.x0))
      .filter(a => Math.abs(a) < 0.2);
    return angles.length ? median(angles) : 0;
  }

  /* remove phonetic transcriptions like [əˈraɪv] or /ˈhaʊs/ */
  function dropPhonetics(row) {
    const out = []; let skip = false;
    for (const w of row.words) {
      const t = w.text;
      if (!skip && /^[\[\/]/.test(t) && t.length > 1) { skip = !/[\]\/]$/.test(t.slice(1)); continue; }
      if (skip) { if (/[\]\/]$/.test(t)) skip = false; continue; }
      if (IPA.test(t)) continue;
      out.push(w);
    }
    row.words = out;
  }

  /* vertical whitespace channels → column boundaries */
  function findBoundaries(rows, hMed) {
    const all = rows.flatMap(r => r.words);
    if (!all.length) return [];
    const minX = Math.min(...all.map(w => w.x0)), maxX = Math.max(...all.map(w => w.x1));
    const W = maxX - minX; if (W <= 0) return [];
    const bins = 240, bw = W / bins, occ = new Array(bins).fill(0);
    const useful = rows.filter(r => r.words.length);
    for (const r of useful) {
      const seen = new Uint8Array(bins);
      for (const w of r.words) {
        const a = Math.max(0, Math.floor((w.x0 - minX) / bw)), b = Math.min(bins - 1, Math.floor((w.x1 - minX) / bw));
        for (let i = a; i <= b; i++) seen[i] = 1;
      }
      for (let i = 0; i < bins; i++) occ[i] += seen[i];
    }
    const limit = Math.max(1, useful.length * 0.12);
    const minRun = Math.max(2, Math.ceil((hMed * 1.1) / bw));
    const bounds = [];
    let i = 0;
    while (i < bins) {
      if (occ[i] <= limit) {
        let j = i; while (j < bins && occ[j] <= limit) j++;
        if (i > 0 && j < bins && j - i >= minRun) bounds.push(minX + ((i + j) / 2) * bw);
        i = j;
      } else i++;
    }
    return bounds;
  }

  /* keep only the vocabulary: no brackets with notes, no stray symbols */
  const clean = s => s
    .replace(/\([^()]{0,40}\)|\[[^\[\]]{0,40}\]|\{[^{}]{0,40}\}|<[^<>]{0,40}>/g, " ")
    .replace(/[()\[\]{}<>|»«*~^_•■□©®°§#@$%&+\\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\d{1,3}[.)]?\s+/, "").replace(/^[\-–—:;,.!]+\s*/, "").replace(/[\s\-–—:]+$/, "")
    .trim();
  const WORDISH = /^[\p{L}][\p{L}'’.\-\/]*[,;!?.]?$|^[¿¡][\p{L}]/u;
  const keepWord = w => {
    const t = w.text, c = w.conf ?? 100;
    if (t === "/" && c >= 50) return true;                     // "der Nachbar / die Nachbarin"
    if (!/\p{L}/u.test(t)) return false;                       // numbers and symbols only
    if (c < 35 && !WORDISH.test(t)) return false;               // unreadable fragments
    if (t.length === 1 && c < 60 && !/^[aAIyoeàé]$/.test(t)) return false;
    return true;
  };
  const textOf = ws0 => {
    // numbers stay only next to real words (e.g. "Unit 3"), never on their own
    const ws = ws0.filter(w => keepWord(w) || (/^\d{1,3}[a-z]?$/.test(w.text) && (w.conf ?? 100) >= 60 && ws0.some(x => x !== w && /\p{L}{2}/u.test(x.text))));
    const t = clean(ws.map(w => w.text).join(" "));
    return t ? t + (ws.some(w => (w.conf ?? 100) < 55) ? " ?" : "") : "";
  };
  const deScore = texts => {
    const t = texts.filter(Boolean); if (!t.length) return 0;
    const hint = t.filter(x => DE_CHARS.test(x) || DE_WORDS.test(x)).length / t.length;
    const cap = t.filter(x => /^[A-ZÄÖÜ]/.test(x)).length / t.length;
    return hint + cap * 0.5;
  };

  /* remove phonetic transcriptions that OCR turned into plain text: /…/ and […] */
  function stripPhon(t) {
    const flag = /\s\?$/.test(t);
    t = t.replace(/\s\?$/, "")
      .replace(/\/[^\/]{0,40}\//g, " ")
      .replace(/\[[^\]]{0,40}\]/g, " ")
      .replace(/(^|\s)\/[^\/]*$/, " ")
      .split(/\s+/)
      // leftovers of phonetics: /…, …/, length marks (a:), stress marks ('ga, ˌse)
      .filter(tok => tok && !/^[\/\\]|[\/\\]$/.test(tok) && !/\p{L}:/u.test(tok) && !/^['ˈˌ,.]\p{L}/u.test(tok))
      .join(" ").trim();
    return t && flag ? t + " ?" : t;
  }

  const HEADING = /^(part|unit|lesson|step|station|topic|theme|module|chapter|teil|kapitel|lektion|unité|unidad|leçon|lección)\b[\s\w.-]{0,12}\??$/i;
  /* common OCR slip in German words: é instead of ö (könntest) */
  const fixDe = t => t.replace(/([A-Za-zäöüß])é(?=[a-zäöüß])/g, "$1ö").replace(/^é/, "ö");

  /* Foreign-language entries start in lower case ("surprise", "dress up").
     A capitalised word behind such an entry is almost always a misread
     phonetic transcription ("surpri Prise", "advice Vice"), and a 1–2 letter
     scrap at the end is a split word ("cent re" → "centre"). */
  const SHORT = new Set("a an to up in on of at by it is be do go so no or if me my we us he she his her its our out off as am are was not one sb sth sb. sth. el la le un de en y o à ".split(" "));
  function fxFix(t) {
    const flag = /\s\?$/.test(t); t = t.replace(/\s\?$/, "");
    let tok = t.split(" ").filter(Boolean);
    if (tok.length >= 2 && /^[\p{Ll}(]/u.test(tok[0])) {
      const last = tok[tok.length - 1];
      if (tok.length >= 2 && /^\p{Ll}{1,2}$/u.test(last) && !SHORT.has(last)) {
        tok.splice(tok.length - 2, 2, tok[tok.length - 2] + last);
      }
    }
    t = tok.join(" ");
    return t && flag ? t + " ?" : t;
  }

  /* lines of one column → [{y, text}] */
  function columnLines(words, angle) {
    if (!words.length) return [];
    const { rows } = groupRows(words, angle);
    rows.forEach(dropPhonetics);
    let skipped = 0;
    const out = rows.filter(r => r.words.length)
      .filter(r => {
        // unreadable scraps (shadows, page edge): low confidence or almost no letters
        const ws = r.words.filter(w => /\p{L}/u.test(w.text));
        if (!ws.length) return false;
        const conf = ws.reduce((s, w) => s + (w.conf ?? 100), 0) / ws.length;
        const letters = ws.map(w => w.text).join("").replace(/[^\p{L}]/gu, "").length;
        if (conf < 35 || (letters <= 3 && conf < 80)) { if (letters >= 3) skipped++; return false; }
        return true;
      })
      .map(r => ({ y: r.cy, text: textOf(r.words), words: r.words })).filter(l => l.text);
    out.skipped = skipped;
    return out;
  }

  /* Match left and right lines by height. The vertical shift between the two
     columns is learned as we go down the page, so curved book pages and
     tilted photos still line up. */
  function alignColumns(leftWords, rightWords, angle, h) {
    let A = columnLines(leftWords, angle), B = columnLines(rightWords, angle);
    const skipped = (A.skipped || 0) + (B.skipped || 0);
    let swapped = false;
    if (deScore(A.map(l => l.text)) > deScore(B.map(l => l.text)) + 0.15) { const t = A; A = B; B = t; swapped = true; }
    // behind a lower-case entry, an unsure capitalised scrap is misread phonetics ("centre Ltti")
    const dropScraps = ws => ws.filter((w, i) => i === 0 || !/^[a-z]/.test(ws[0].text) || !/^\p{Lu}/u.test(w.text) || (w.conf ?? 100) >= 70 || w.text === "I");
    A = A.map(l => ({ ...l, text: fxFix(stripPhon(textOf(dropScraps(l.words)))) })).filter(l => l.text.replace(/\s\?$/, "").length > 0);
    A.sort((a, b) => a.y - b.y); B.sort((a, b) => a.y - b.y);

    const tol = h * 0.8;
    // one pass down the page, starting with shift d0, adapting the shift on every match
    function run(d0) {
      let d = d0, score = 0;
      const pairs = []; let title = ""; let j = 0;
      const addCont = text => {
        if (pairs.length) { const pr = pairs[pairs.length - 1]; pr.de = (pr.de.replace(/\s\?$/, "") + " " + text).trim(); score -= 0.4; }
        else score -= 1;
      };
      for (const a of A) {
        while (j < B.length && B[j].y - d < a.y - tol) { addCont(B[j].text); j++; }
        let k = -1;
        if (j < B.length && Math.abs(B[j].y - d - a.y) <= tol) k = j;
        if (k >= 0 && j + 1 < B.length && Math.abs(B[j + 1].y - d - a.y) < Math.abs(B[j].y - d - a.y)) { addCont(B[j].text); k = j + 1; }
        if (k >= 0) {
          const miss = Math.abs(B[k].y - d - a.y) / tol;
          score += 2 - miss;
          pairs.push({ fx: a.text, de: B[k].text });
          d = d * 0.6 + (B[k].y - a.y) * 0.4;
          j = k + 1;
        } else if (!pairs.length && !title) {
          title = a.text.replace(/\s\?$/, "");
        } else if (HEADING.test(a.text)) {
          // section heading inside the list ("Part A") – skip
        } else {
          pairs.push({ fx: a.text, de: "" }); score -= 1;
        }
      }
      while (j < B.length) { addCont(B[j].text); j++; }
      return { pairs, title, score };
    }
    // try a range of starting shifts and keep the most consistent result
    let best = null;
    for (let s = -2.5; s <= 2.5001; s += 0.125) {
      const r = run(s * h);
      if (!best || r.score > best.score + 1e-9 || (Math.abs(r.score - best.score) < 1e-9 && Math.abs(s) < Math.abs(best.s))) best = { ...r, s };
    }
    const out = best.pairs.map(p => ({ fx: p.fx, de: fixDe(p.de).replace(/[,;]\s*$/, "") }));
    return { pairs: out, title: best.title, swapped, skipped };
  }

  /* On curved pages OCR sometimes cuts one bold word into two pieces that
     land on different text lines: "cent"+"re", "advi"+"ce", "surpri"+"Prise".
     Pieces that touch or overlap side by side are joined again. */
  function mergeSplitWords(words) {
    if (!words.some(w => w.line !== undefined)) return words;
    const ws = words.map(w => ({ ...w })).sort((a, b) => a.x0 - b.x0);
    const LET = /^[\p{L}][\p{L}'’-]*$/u;
    let changed = true;
    while (changed) {
      changed = false;
      outer: for (let i = 0; i < ws.length; i++) {
        const a = ws[i]; if (!LET.test(a.text)) continue;
        for (let j = 0; j < ws.length; j++) {
          const b = ws[j];
          if (i === j || b.line === a.line || !/^[\p{L}][\p{L}'’-]*[.,;]?$/u.test(b.text)) continue;
          if (b.x0 <= a.x0) continue;
          const ha = a.y1 - a.y0, hb = b.y1 - b.y0, h = Math.min(ha, hb);
          const gap = b.x0 - a.x1;
          const vov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          if (gap > h * 0.3 || gap < -Math.max(ha, hb) * 2 || vov < h * 0.4) continue;
          // drop letters both pieces share ("surpri" + "Prise" → "surprise")
          const A = a.text, B = b.text; let k = 0;
          for (let n = Math.min(A.length, B.length) - 1; n >= 2; n--) if (A.slice(-n).toLowerCase() === B.slice(0, n).toLowerCase()) { k = n; break; }
          if (gap < -h * 0.5 && k === 0) continue;
          a.text = A + B.slice(k);
          a.x1 = Math.max(a.x1, b.x1); a.y0 = Math.min(a.y0, b.y0); a.y1 = Math.max(a.y1, b.y1);
          a.conf = Math.min(a.conf ?? 100, b.conf ?? 100);
          ws.splice(j, 1); changed = true; break outer;
        }
      }
    }
    return ws;
  }

  function pairFromWords(words, opts = {}) {
    words = mergeSplitWords(words);
    const { rows, hMed } = groupRows(words, opts.angle);
    rows.forEach(dropPhonetics);
    const live = rows.filter(r => r.words.length);
    const bounds = findBoundaries(live, hMed);
    let table; // [[col0, col1, ...] per row]
    let note = "";

    if (bounds.length) {
      const nCols = bounds.length + 1;
      table = live.map(r => {
        const cols = Array.from({ length: nCols }, () => []);
        for (const w of r.words) {
          const cx = (w.x0 + w.x1) / 2;
          let c = 0; while (c < bounds.length && cx > bounds[c]) c++;
          cols[c].push(w);
        }
        return cols.map(ws => (ws.length ? textOf(ws) : ""));
      });
      // keep columns that carry real content
      let keep = [...Array(nCols).keys()].filter(c => table.filter(r => r[c]).length >= Math.max(1, live.length * 0.25));
      if (keep.length > 2) note = "Eine weitere Spalte (z. B. Beispielsätze) wurde weggelassen.";
      if (keep.length < 2) keep = [0, Math.min(1, nCols - 1)];
      keep = keep.slice(0, 2);
      if (keep[0] !== keep[1]) {
        // two real columns: read each column on its own, then match the lines
        const colOf = w => { const cx = (w.x0 + w.x1) / 2; let c = 0; while (c < bounds.length && cx > bounds[c]) c++; return c; };
        const all = live.flatMap(r => r.words);
        const res = alignColumns(all.filter(w => colOf(w) === keep[0]), all.filter(w => colOf(w) === keep[1]), opts.angle, hMed);
        return { ...res, note, columns: nCols };
      }
      table = table.map(r => [r[keep[0]] || "", r[keep[1]] || ""]);
    } else {
      // single column: "dog – Hund", "dog = Hund", "dog: Hund"
      table = live.map(r => {
        const t = textOf(r.words);
        const m = t.split(/\s+[-–—=:]\s+|\s*=\s*/);
        return m.length >= 2 ? [m[0], m.slice(1).join(" – ")] : [t, ""];
      });
    }

    // German on the right
    let swapped = false;
    if (deScore(table.map(r => r[0])) > deScore(table.map(r => r[1])) + 0.15) {
      table = table.map(r => [r[1], r[0]]); swapped = true;
    }

    // a row that only has the German side, directly followed by a row that only
    // has the foreign side (or the other way round), is one entry split by tilt
    for (let i = 0; i + 1 < table.length; i++) {
      const [a1, b1] = table[i], [a2, b2] = table[i + 1];
      const close = live[i + 1] && live[i] && (live[i + 1].cy - live[i].cy) < hMed * 1.3;
      if (close && ((!a1 && b1 && a2 && !b2) || (a1 && !b1 && !a2 && b2))) {
        table[i] = [a1 || a2, b1 || b2]; table.splice(i + 1, 1); live.splice(i + 1, 1);
      }
    }

    const pairs = []; let title = "";
    for (const [a, b] of table) {
      if (a && b) pairs.push({ fx: a, de: b });
      else if (!a && b) { if (pairs.length) pairs[pairs.length - 1].de += " " + b; }
      else if (a && !b) {
        if (!pairs.length) { if (!title) title = a.replace(/\s\?$/, ""); }
        else pairs.push({ fx: a, de: "" });
      }
    }
    return { pairs, title, note, swapped, columns: bounds.length + 1 };
  }

  const api = { mergeSplitWords, pairFromWords, groupRows, findBoundaries, tiltFromBaselines };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VkPair = api;
})(typeof self !== "undefined" ? self : this);
