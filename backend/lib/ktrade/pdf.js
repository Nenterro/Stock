'use strict';

const zlib = require('zlib');

/**
 * Minimal text extractor for the PDFs KTrade emails out.
 *
 * Those are produced by Oracle Reports, which lays every label and value out at
 * an explicit coordinate. Reading the operators linearly gives a scrambled mess
 * (the value for "Quantity" can appear pages away from its heading), so this
 * keeps the x/y of each string and rebuilds the visual rows instead. That is
 * what makes column-based parsing reliable.
 *
 * Deliberately dependency-free: the content streams are uncompressed, or at
 * worst Flate, both of which Node handles natively.
 */

/** Content streams that contain text-showing operators, one per page. */
function pageStreams(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const re = /<<([^>]*?)>>\s*stream\r?\n/g;
  let m;

  while ((m = re.exec(s))) {
    const dict = m[1];
    const start = re.lastIndex;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;

    let data = buf.subarray(start, end);
    if (/FlateDecode/.test(dict)) {
      try {
        data = zlib.inflateSync(data);
      } catch {
        continue; // not our stream, or damaged - skip it
      }
    }

    const text = data.toString('latin1');
    if (text.includes(' Tj') || text.includes(' TJ')) out.push(text);
  }

  return out;
}

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

function unescapePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (ESCAPES[next] !== undefined) {
      out += ESCAPES[next];
      i += 1;
    } else if (next >= '0' && next <= '7') {
      // Octal character code, up to three digits.
      let oct = '';
      let j = i + 1;
      while (j < raw.length && oct.length < 3 && raw[j] >= '0' && raw[j] <= '7') {
        oct += raw[j];
        j += 1;
      }
      out += String.fromCharCode(parseInt(oct, 8));
      i = j - 1;
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
}

/**
 * Positioned strings from one content stream.
 *
 * Td/TD are *relative* offsets from the start of the previous text line, and BT
 * resets the text matrix to the origin - so position has to be accumulated
 * within each BT/ET block and zeroed at every BT. Treating the offsets as
 * absolute yields negative x values and every row collapsed onto y=0.
 */
function items(content) {
  const out = [];
  let x = 0;
  let y = 0;

  const BEGIN = /\bBT\b/g;
  const MOVE = /(-?[\d.]+)\s+(-?[\d.]+)\s+(?:TD|Td)/g;
  const MATRIX = /(?:-?[\d.]+\s+){4}(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/g;
  const SHOW = /\(((?:[^()\\]|\\[\s\S])*)\)\s*Tj/g;

  // One pass over the stream, dispatching on whichever operator comes next.
  const combined = new RegExp(
    `${BEGIN.source}|${MOVE.source}|${MATRIX.source}|${SHOW.source}`,
    'g'
  );
  let m;
  while ((m = combined.exec(content))) {
    if (m[1] !== undefined) {
      // Td/TD: relative move.
      x += parseFloat(m[1]);
      y += parseFloat(m[2]);
    } else if (m[3] !== undefined) {
      // Tm: absolute placement.
      x = parseFloat(m[3]);
      y = parseFloat(m[4]);
    } else if (m[5] !== undefined) {
      const text = unescapePdfString(m[5]);
      if (text.trim()) out.push({ x, y, text: text.trim() });
    } else {
      // BT: new text object, matrix back to the origin.
      x = 0;
      y = 0;
    }
  }

  return out;
}

/** Group positioned strings into visual rows, each sorted left to right. */
function rows(positioned, tolerance = 2.0) {
  const sorted = [...positioned].sort((a, b) => b.y - a.y || a.x - b.x);
  const grouped = [];

  for (const item of sorted) {
    const row = grouped.find((r) => Math.abs(r.y - item.y) <= tolerance);
    if (row) {
      row.cells.push(item);
      row.y = (row.y + item.y) / 2;
    } else {
      grouped.push({ y: item.y, cells: [item] });
    }
  }

  grouped.forEach((r) => r.cells.sort((a, b) => a.x - b.x));
  return grouped;
}

/** Convenience: [{ rows: [...] }] per page. */
function readPages(buf) {
  return pageStreams(buf).map((content) => ({ rows: rows(items(content)) }));
}

module.exports = { pageStreams, items, rows, readPages, unescapePdfString };
