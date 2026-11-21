// A faster drop-in for csv-reader 1.0.0, make.fun's own CSV reader.
//
// run(input) returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}. The reading, as csv-reader's own code defines it:
//
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record; a line that held only stray CRs is no record either, though its
//     stray_cr errors stay;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote and each CRLF or lone CR inside it read
//     as LF; what follows its closing quote, up to the next comma or line
//     break, is appended as it stands (quote_junk, when the field ends); a
//     quote that never closes is a literal character, and the text after it is
//     read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its field count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when the record
//     ends: line the 1-based line its record starts on, counting every LF,
//     CRLF and lone CR inside quotes, and row its record's index in rows,
//     null for the header.
//
// How it is fast: csv-reader reads one character at a time and builds every
// field a character at a time. This reader never walks a character twice and
// never builds a string a character at a time:
//
//   - a record whose first line holds no quote and no stray CR is split whole
//     by String.prototype.split(',') (a C++ scan), its fields sliced, not
//     built;
//   - every other field is found by indexOf (memchr) for its terminator and
//     sliced out; a quoted field's closing quote is one indexOf, and its
//     content is one slice unless it holds a doubled quote or a line break;
//   - CR/LF checks inside a field run on the sliced field (includes), never
//     as an unbounded indexOf, so a file with almost no CRs costs no long
//     scans;
//   - newlines inside a quoted field are counted, not re-walked, and the line
//     count a failed (unterminated) quoted scan would have added is never
//     applied, which is what csv-reader's reset to the opening line does.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the
// next. Each case is answered alone.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of the record carries these.
  let recordLine = 1;
  let recordRow = null;
  // Index of the next LF at or after pos on the record's current physical
  // line (n when there is none). Recomputed when a quoted field consumes one.
  let lineEnd = n;
  // How the current field ended (COMMA, BREAK or END).
  let ended = END;

  // A record's end: the header, the width, a short or long row's error.
  function finish(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // Reads an unquoted field (or the unquoted tail of one) starting at pos,
  // appending to `value`. Sets `ended` and advances pos and line. A CR in the
  // field is stray (any CR before the field's end is one: a CRLF's CR sits at
  // lineEnd - 1 and is cut off with the break): one stray_cr error each,
  // dropped. When isJunk, a quote_junk error is recorded if any character was
  // kept, after the stray_cr errors, as csv-reader records it when the field
  // ends.
  function unquoted(value, isJunk) {
    const c = text.indexOf(',', pos);
    let end;
    if (c !== -1 && c < lineEnd) {
      end = c;
      ended = COMMA;
    } else if (lineEnd < n) {
      end = lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
      ended = BREAK;
    } else {
      end = n;
      ended = END;
    }
    let seg = text.slice(pos, end);
    if (seg.includes('\r')) {
      const parts = seg.split('\r');
      for (let i = 1; i < parts.length; i++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      seg = parts.join('');
    }
    if (isJunk && seg.length > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    if (ended === COMMA) pos = end + 1;
    else if (ended === BREAK) {
      pos = lineEnd + 1;
      line += 1;
    } else pos = n;
    return value + seg;
  }

  // Reads a quoted field whose opening quote is at pos. Returns its value and
  // sets `ended`, advancing pos, line and lineEnd.
  function quoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let s = pos + 1;
    let newlines = 0; // line breaks inside the field, added to line on close
    let sawLF = false; // a real LF was consumed: lineEnd must move
    for (;;) {
      const j = text.indexOf('"', s);
      if (j === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted. What the failed scan saw is
        // discarded, and line never moved, which is csv-reader's reset to
        // the opening line.
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        pos = open + 1;
        line = openLine;
        return unquoted('"', false);
      }
      const seg = text.slice(s, j);
      if (seg.includes('\n') || seg.includes('\r')) {
        // CRLF and a lone CR inside quotes are each one LF.
        let out = '';
        let p = 0;
        for (;;) {
          const a = seg.indexOf('\r', p);
          const b = seg.indexOf('\n', p);
          if (a === -1 && b === -1) {
            out += seg.slice(p);
            break;
          }
          let k;
          let isCR;
          if (b === -1 || (a !== -1 && a < b)) {
            k = a;
            isCR = true;
          } else {
            k = b;
            isCR = false;
          }
          out += seg.slice(p, k);
          out += '\n';
          newlines += 1;
          if (!isCR || seg.charCodeAt(k + 1) === 10) sawLF = true;
          p = isCR && seg.charCodeAt(k + 1) === 10 ? k + 2 : k + 1;
        }
        value += out;
      } else {
        value += seg;
      }
      if (text.charCodeAt(j + 1) === 34) {
        // A doubled quote is one quote; the field goes on.
        value += '"';
        s = j + 2;
        continue;
      }
      // The closing quote.
      pos = j + 1;
      break;
    }
    line += newlines;
    if (sawLF) {
      lineEnd = text.indexOf('\n', pos);
      if (lineEnd === -1) lineEnd = n;
    }
    if (pos >= n) {
      ended = END;
      return value;
    }
    const t = text.charCodeAt(pos);
    if (t === 44) {
      pos += 1;
      ended = COMMA;
      return value;
    }
    if (t === 10) {
      pos += 1;
      line += 1;
      ended = BREAK;
      return value;
    }
    if (t === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      ended = BREAK;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    return unquoted(value, true);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = n;

    // Fast path: the record's first line holds no quote, so no quoted field
    // can open on it and the record ends at its break; and it holds no stray
    // CR. Split the line whole.
    const q = text.indexOf('"', pos);
    if (q === -1 || q >= lineEnd) {
      const contentEnd =
        lineEnd < n && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
      const lineStr = text.slice(pos, contentEnd);
      if (!lineStr.includes('\r')) {
        const fields = lineStr.split(',');
        if (lineEnd < n) {
          pos = lineEnd + 1;
          line += 1;
        } else pos = n;
        finish(fields);
        continue;
      }
    }

    // Slow path: field by field.
    const fields = [];
    let quotedFlag = false;
    do {
      let value;
      if (text.charCodeAt(pos) === 34) {
        quotedFlag = true;
        value = quoted();
      } else {
        quotedFlag = false;
        value = unquoted('', false);
      }
      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quotedFlag) continue;
    finish(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
