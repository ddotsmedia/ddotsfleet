/** RFC 4180 subset: quoted fields, doubled quotes, CRLF or LF. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (inQuotes) throw new Error("csv_unterminated_quote");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
}

/**
 * Serialises rows with RFC 4180 quoting. Cells that start with a spreadsheet formula trigger
 * character get a leading apostrophe so that opening the export cannot run a formula.
 */
export function toCsv(headers: string[], rows: string[][]): string {
  const cell = (value: string): string => {
    const safe = /^[=+@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\r\n]/.test(safe) || safe !== value ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
