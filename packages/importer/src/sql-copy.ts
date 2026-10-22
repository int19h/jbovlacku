import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

export interface CopyRow {
  table: string;
  columns: string[];
  values: (string | null)[];
  row: number;
  line: number;
  error?: string;
}

/** Decode PostgreSQL COPY text. The null marker is tested before escapes. */
export function decodeCopyField(value: string): string | null {
  if (value === "\\N") return null;
  const bytes: Buffer[] = [];
  let position = 0;
  for (const match of value.matchAll(
    /\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|[\s\S])/g,
  )) {
    bytes.push(Buffer.from(value.slice(position, match.index)));
    const escape = match[1];
    if (/^[0-7]/.test(escape)) bytes.push(Buffer.from([parseInt(escape, 8)]));
    else if (escape[0] === "x" && escape.length > 1)
      bytes.push(Buffer.from([parseInt(escape.slice(1), 16)]));
    else
      bytes.push(
        Buffer.from(
          (
            { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" } as Record<
              string,
              string
            >
          )[escape] ?? escape,
        ),
      );
    position = match.index! + match[0].length;
  }
  bytes.push(Buffer.from(value.slice(position)));
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Buffer.concat(bytes),
  );
}

/** Ignore unrelated table rows without joining their potentially large byte chunks. */
export async function* readCopyRows(
  path: string,
  wanted: ReadonlySet<string>,
  onTable?: (table: string, rows: number) => void,
): AsyncGenerator<CopyRow> {
  let table: string | null = null;
  let columns: string[] = [];
  let row = 0;
  let line = 0;
  let pieces: Buffer[] = [];
  let length = 0;
  let overLimit = false;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const rowLimit = 32 * 1024 * 1024;
  for await (const chunk of createReadStream(path, {
    highWaterMark: 256 * 1024,
  })) {
    const bytes = chunk as Buffer;
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(10, start);
      const stop = end < 0 ? bytes.length : end;
      const part = bytes.subarray(start, stop);
      length += part.length;
      const retain = table === null || wanted.has(table) || length <= 8;
      if (retain && !overLimit) {
        if (length > rowLimit) {
          overLimit = true;
          pieces = [];
        } else pieces.push(part);
      }
      if (end < 0) break;
      line++;
      let text = "";
      let rowDecodeError: string | undefined;
      if (!overLimit && pieces.length) {
        const joined = Buffer.concat(pieces);
        const clean = joined.at(-1) === 13 ? joined.subarray(0, -1) : joined;
        try {
          text = decoder.decode(clean);
        } catch {
          if (table === null)
            throw new Error(
              "A SQL source header contains invalid UTF-8 bytes.",
            );
          rowDecodeError = "The COPY row contains invalid UTF-8 bytes.";
        }
      }
      if (table === null) {
        const match = /^COPY public\.([a-z_]+) \((.*)\) FROM stdin;$/.exec(
          text,
        );
        if (match) {
          table = match[1];
          columns = match[2]
            .split(/,\s*/)
            .map((name) => name.replace(/^"|"$/g, ""));
          row = 0;
        }
      } else if (text === "\\.") {
        onTable?.(table, row);
        table = null;
      } else {
        row++;
        if (wanted.has(table)) {
          let values: (string | null)[] = [];
          let decodeError = rowDecodeError;
          try {
            if (!overLimit) values = text.split("\t").map(decodeCopyField);
          } catch {
            decodeError = "A COPY field contains invalid escaped UTF-8 bytes.";
          }
          yield {
            table,
            columns,
            values,
            row,
            line,
            ...(decodeError
              ? { error: decodeError }
              : overLimit
                ? { error: "The COPY row exceeds the local 32 MiB read limit." }
                : values.length !== columns.length
                  ? {
                      error: `The COPY row has ${values.length} fields instead of ${columns.length}.`,
                    }
                  : {}),
          };
        }
      }
      pieces = [];
      length = 0;
      overLimit = false;
      start = end + 1;
    }
  }
  if (length) throw new Error("The SQL source ends without a complete line.");
  if (table !== null)
    throw new Error("The SQL source ends inside a COPY block.");
}

export async function hashFile(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { sha256: `sha256:${hash.digest("hex")}`, bytes };
}
