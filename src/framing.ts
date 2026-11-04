import { StringDecoder } from 'node:string_decoder';

/**
 * Splits a byte stream into newline-delimited lines (the MCP stdio framing).
 * Handles partial chunks, several messages per chunk, CRLF and UTF-8
 * sequences split across chunk boundaries. Empty lines are skipped.
 */
export class LineSplitter {
  private buf = '';
  private readonly decoder = new StringDecoder('utf8');

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim() !== '') this.onLine(line);
    }
  }

  /** Flush a trailing line that had no terminating newline. */
  end(): void {
    this.buf += this.decoder.end();
    const rest = this.buf.replace(/\r$/, '');
    this.buf = '';
    if (rest.trim() !== '') this.onLine(rest);
  }
}

/** Parse one line as JSON, returning undefined when it is not valid JSON. */
export function tryParse(line: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
}

/** Drop a leading UTF-8 byte order mark, which JSON.parse rejects. */
export function stripBom(line: string): string {
  return line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
}
