/* Copyright 2026 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Detect and repair a broken cross-reference table of a PDF document.
 *
 * Some producers (e.g. certain PDF merge tools) write xref entries that point
 * at wrong byte offsets. Viewers like WPS silently rebuild the index, while
 * pdf.js falls back to its own recovery (`XRef.indexObjects`), which requires
 * scanning the entire file -- impractical for multi-GB documents.
 *
 * This module implements a cheap probe (`probeXref`) and, when the xref turns
 * out to be broken, a full object-header scan (`rebuildXrefSection`) that
 * produces a brand-new xref section to be *appended* to the file (classic
 * incremental-update semantics, the original bytes stay untouched). The
 * appendix can then be exposed to pdf.js either by concatenating Blobs
 * (`new Blob([file, section])`, no data copy) or by a range transport that
 * serves the appendix past the end of the original data.
 *
 * The functions here are deliberately free of any pdf.js imports so they can
 * be unit-tested in plain Node.js.
 */

const TAIL_SIZE = 4096;
const PROBE_HEAD_SIZE = 65536;
const SCAN_CHUNK_SIZE = 128 * 1024 * 1024;
const SCAN_OVERLAP = 128;

// Matches an indirect object header, e.g. "123 0 obj", without being part of
// a longer number.
const OBJ_HEADER_RE = /(?<![\d.])(\d{1,7}) (\d{1,5}) obj(?!\d)/g;

// NOTE: the Encoding Standard maps "latin1"/"iso-8859-1" to windows-1252,
// which is NOT byte-identical for 0x80-0x9F. That is fine here: decoding is
// one char per byte (so string offsets == byte offsets) and every byte we
// care about (digits, whitespace, "obj") is ASCII, which maps identically.
const latin1Decoder = new TextDecoder("windows-1252");

function latin1(bytes) {
  return latin1Decoder.decode(bytes);
}

function extractRef(str, key) {
  const m = new RegExp(`\\/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`).exec(str);
  return m ? `${m[1]} ${m[2]} R` : null;
}

/**
 * Extract the trailer fields we need to carry over into a rebuilt xref
 * section, from any string containing a trailer-ish dictionary.
 */
function parseTrailerParts(str) {
  let id = null;
  const idMatch = /\/ID\s*\[(.*?)\]/s.exec(str);
  if (idMatch) {
    id = `ID[${idMatch[1].replaceAll(/\s+/g, "")}]`;
  }
  let sizeHint = 0;
  const sizeMatch = /\/Size\s+(\d+)/.exec(str);
  if (sizeMatch) {
    sizeHint = parseInt(sizeMatch[1], 10);
  }
  return {
    root: extractRef(str, "Root"),
    info: extractRef(str, "Info"),
    encrypt: extractRef(str, "Encrypt"),
    id,
    sizeHint,
  };
}

/**
 * Parse a classic "xref" table section (starting at the "xref" keyword).
 * @returns {{entries: Map, trailerStr: string}}
 */
function parseClassicXref(head) {
  const entries = new Map();
  let pos = 4; // Skip "xref".
  let trailerStr = head;
  while (pos < head.length) {
    const rest = head.slice(pos);
    if (/^[ \t\r\n]*trailer\b/.test(rest)) {
      trailerStr = rest.slice(rest.indexOf("trailer"));
      break;
    }
    const m = /^[ \t\r\n]*(\d+)[ \t]+(\d+)[ \t]*\r?\n/.exec(rest);
    if (!m) {
      break;
    }
    const first = parseInt(m[1], 10);
    const count = parseInt(m[2], 10);
    let entryPos = pos + m[0].length;
    for (let i = 0; i < count; i++, entryPos += 20) {
      const em = /^(\d{10}) (\d{5}) ([nf])/.exec(
        head.slice(entryPos, entryPos + 20)
      );
      if (em?.[3] === "n") {
        entries.set(first + i, {
          offset: parseInt(em[1], 10),
          gen: parseInt(em[2], 10),
        });
      }
    }
    pos = entryPos;
  }
  return { entries, trailerStr };
}

/**
 * Cheaply probe whether the document's xref is usable.
 *
 * @param {function(number, number): Promise<Uint8Array>} readRange
 *   Reads [begin, end) of the document.
 * @param {number} size - Total document size in bytes.
 * @returns {Promise<{status: "ok"|"broken"|"unknown", reason?: string,
 *   startXref?: number, trailer?: object, tailStr?: string}>}
 *   "ok"     -- xref looks valid, open directly;
 *   "broken" -- xref is definitely damaged, a rebuild is worthwhile;
 *   "unknown"-- cannot tell (not a PDF, unparseable, ...), open directly and
 *               let pdf.js deal with it.
 */
async function probeXref(readRange, size) {
  if (size < 16) {
    return { status: "unknown", reason: "file too small" };
  }
  const header = latin1(await readRange(0, Math.min(8, size)));
  if (!header.startsWith("%PDF-")) {
    return { status: "unknown", reason: "not a PDF document" };
  }
  const tailStr = latin1(await readRange(Math.max(0, size - TAIL_SIZE), size));
  const sxIdx = tailStr.lastIndexOf("startxref");
  if (sxIdx === -1) {
    return { status: "broken", reason: "startxref missing", tailStr };
  }
  const sxMatch = /startxref\s+(\d+)/.exec(tailStr.slice(sxIdx));
  if (!sxMatch) {
    return { status: "unknown", reason: "startxref unparsable", tailStr };
  }
  const startXref = parseInt(sxMatch[1], 10);
  if (startXref >= size) {
    return {
      status: "broken",
      reason: "startxref beyond EOF",
      startXref,
      tailStr,
    };
  }
  const head = latin1(
    await readRange(startXref, Math.min(size, startXref + PROBE_HEAD_SIZE))
  );

  if (head.startsWith("xref")) {
    const { entries, trailerStr } = parseClassicXref(head);
    const trailer = parseTrailerParts(trailerStr);
    // Spot-check the /Root entry plus a few others: each must point at a
    // matching "N G obj" header.
    const checks = [];
    if (trailer.root) {
      const rootNum = parseInt(trailer.root, 10);
      const entry = entries.get(rootNum);
      if (!entry) {
        return {
          status: "broken",
          reason: "Root object missing from xref",
          startXref,
          trailer,
          tailStr,
        };
      }
      checks.push([rootNum, entry]);
    }
    let extra = 0;
    for (const [num, entry] of entries) {
      if (extra >= 3) {
        break;
      }
      if (!checks.some(([n]) => n === num)) {
        checks.push([num, entry]);
        extra++;
      }
    }
    for (const [num, entry] of checks) {
      if (entry.offset >= size) {
        return {
          status: "broken",
          reason: `xref entry ${num} beyond EOF`,
          startXref,
          trailer,
          tailStr,
        };
      }
      const hdr = latin1(
        await readRange(entry.offset, Math.min(size, entry.offset + 64))
      ).trimStart();
      const hm = /^(\d+)\s+\d+\s+obj\b/.exec(hdr);
      if (!hm || parseInt(hm[1], 10) !== num) {
        return {
          status: "broken",
          reason: `xref entry ${num} points to "${hdr.slice(0, 24)}"`,
          startXref,
          trailer,
          tailStr,
        };
      }
    }
    return { status: "ok", startXref, trailer, tailStr };
  }

  // An xref *stream* (PDF 1.5+): only a light sanity check -- the binary
  // entries are not spot-checked.
  if (
    /^\s*\d+\s+\d+\s+obj\b/.test(head) &&
    head.includes("/XRef") &&
    /\/Root\s+\d+\s+\d+\s+R/.test(head)
  ) {
    return { status: "ok", startXref, trailer: parseTrailerParts(head) };
  }
  return {
    status: "broken",
    reason: "startxref does not point at an xref",
    startXref,
    trailer: parseTrailerParts(tailStr),
    tailStr,
  };
}

/**
 * Sequentially scan the whole document for indirect object headers and
 * build a replacement xref section to append at `size`.
 *
 * @param {function(number, number): Promise<Uint8Array>} readRange
 * @param {number} size - Total document size in bytes; the new section is
 *   written as if appended at this offset.
 * @param {object} probe - The result of `probeXref` (used for the trailer).
 * @param {function(number, number): void} [onProgress] - (bytesRead, total).
 * @returns {Promise<Uint8Array|null>} The xref section bytes, or `null` when
 *   a rebuild is not safe/possible (object streams present, no Root found,
 *   no objects found) and the caller should fall back to the original file.
 */
async function rebuildXrefSection(readRange, size, probe, onProgress) {
  const locations = new Map(); // num -> {offset, gen}, last occurrence wins.
  let objStmFound = false;

  for (let off = 0; off < size; off += SCAN_CHUNK_SIZE) {
    const end = Math.min(size, off + SCAN_CHUNK_SIZE + SCAN_OVERLAP);
    const s = latin1(await readRange(off, end));
    if (s.includes("/ObjStm")) {
      objStmFound = true;
    }
    OBJ_HEADER_RE.lastIndex = 0;
    let m;
    while ((m = OBJ_HEADER_RE.exec(s)) !== null) {
      const absPos = off + m.index;
      if (absPos >= size) {
        break;
      }
      // The header must start at the beginning of a line, and the object
      // content must start with a plausible token (filters out most random
      // "N G obj" occurrences inside stream data).
      const before = m.index > 0 ? s[m.index - 1] : "\n";
      if (before !== "\n" && before !== "\r") {
        continue;
      }
      const after = s.slice(m.index + m[0].length).replace(/^[\r\n ]+/, "")[0];
      if (!"<[/(-+.0123456789tfn".includes(after)) {
        continue;
      }
      locations.set(parseInt(m[1], 10), {
        offset: absPos,
        gen: parseInt(m[2], 10),
      });
    }
    onProgress?.(Math.min(size, off + SCAN_CHUNK_SIZE), size);
  }

  if (objStmFound || locations.size === 0) {
    return null;
  }
  const trailer = probe?.trailer?.root
    ? probe.trailer
    : parseTrailerParts(probe?.tailStr ?? "");
  if (!trailer.root || !locations.has(parseInt(trailer.root, 10))) {
    return null;
  }

  const maxNum = Math.max((trailer.sizeHint || 1) - 1, ...locations.keys());
  const parts = [`xref\r\n0 ${maxNum + 1}\r\n`];
  for (let n = 0; n <= maxNum; n++) {
    const e = locations.get(n);
    parts.push(
      e
        ? `${String(e.offset).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n\r\n`
        : "0000000000 65535 f\r\n"
    );
  }
  let trailerStr = `<</Size ${maxNum + 1}/Root ${trailer.root}`;
  if (trailer.info) {
    trailerStr += `/Info ${trailer.info}`;
  }
  if (trailer.encrypt) {
    trailerStr += `/Encrypt ${trailer.encrypt}`;
  }
  if (trailer.id) {
    trailerStr += `/${trailer.id}`;
  }
  if (probe?.startXref !== undefined) {
    trailerStr += `/Prev ${probe.startXref}`;
  }
  trailerStr += ">>";
  parts.push(`trailer\r\n${trailerStr}\r\nstartxref\r\n${size}\r\n%%EOF\r\n`);

  // The section is pure ASCII, so UTF-8 encoding is byte-identical.
  return new TextEncoder().encode(parts.join(""));
}

/**
 * Create a range reader over a remote URL using HTTP Range requests.
 * Only usable in environments with `fetch` (i.e. the browser viewer).
 */
function makeUrlRangeReader(url) {
  let size = -1;
  const readRange = async (begin, end) => {
    const resp = await fetch(url, {
      headers: { Range: `bytes=${begin}-${end - 1}` },
    });
    if (resp.status !== 206) {
      throw new Error(`Range request not supported (status ${resp.status}).`);
    }
    const contentRange = resp.headers.get("content-range");
    const m = /\/(\d+)\s*$/.exec(contentRange ?? "");
    if (m) {
      size = parseInt(m[1], 10);
    }
    return new Uint8Array(await resp.arrayBuffer());
  };
  return {
    readRange,
    async size() {
      if (size < 0) {
        await readRange(0, 1);
      }
      return size;
    },
  };
}

export { makeUrlRangeReader, probeXref, rebuildXrefSection };
