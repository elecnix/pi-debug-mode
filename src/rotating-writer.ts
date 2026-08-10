/**
 * Bounded, rotating on-disk output.
 *
 * The rolling trace is append-only and rotates when the current file exceeds
 * `maxFileBytes`. Snapshots are standalone files. In both cases the directory
 * never holds more than `maxFiles` .jsonl files total — the oldest are deleted
 * first — so disk usage is bounded no matter how long pi runs.
 */
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface RotatingWriterOptions {
  maxFiles: number;
  maxFileBytes: number;
}

export class RotatingWriter {
  private currentPath?: string;
  private currentBytes = 0;
  private nextSeq: number;

  constructor(
    private readonly dir: string,
    private readonly opts: RotatingWriterOptions,
  ) {
    this.nextSeq = this.findNextSeq();
  }

  /** Append one line to the current trace file, rotating first if needed. */
  appendLine(line: string, fsync = false): void {
    if (!this.currentPath) this.openNext();
    const bytes = Buffer.byteLength(line, "utf8") + 1; // + trailing newline
    if (this.currentBytes + bytes > this.opts.maxFileBytes && this.currentBytes > 0) {
      this.openNext();
    }
    appendFileSync(this.currentPath!, line + "\n", "utf8");
    this.currentBytes += bytes;
    this.enforceBudget();
    if (fsync) this.fsyncCurrent();
  }

  /** Write a standalone snapshot file and enforce the directory file budget. */
  writeSnapshot(name: string, lines: string[]): string {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, name);
    writeFileSync(path, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
    this.enforceBudget();
    return path;
  }

  currentFile(): string | undefined {
    return this.currentPath;
  }

  /** Durably flush the current trace file to disk. */
  fsyncCurrent(): void {
    if (!this.currentPath) return;
    const fd = openSync(this.currentPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private openNext(): string {
    mkdirSync(this.dir, { recursive: true });
    this.currentPath = join(this.dir, `trace-${String(this.nextSeq).padStart(6, "0")}.jsonl`);
    this.nextSeq++;
    this.currentBytes = 0;
    return this.currentPath;
  }

  private findNextSeq(): number {
    try {
      let max = 0;
      for (const f of readdirSync(this.dir)) {
        const m = /^trace-(\d+)\.jsonl$/.exec(f);
        if (m) max = Math.max(max, Number(m[1]));
      }
      return max + 1;
    } catch {
      return 1;
    }
  }

  /** Delete oldest .jsonl files (by mtime, then name) beyond the max. */
  private enforceBudget(): void {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return;
    }
    if (files.length <= this.opts.maxFiles) return;
    files.sort((a, b) => {
      const at = statSync(join(this.dir, a)).mtimeMs;
      const bt = statSync(join(this.dir, b)).mtimeMs;
      if (at !== bt) return at - bt;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const excess = files.length - this.opts.maxFiles;
    for (const f of files.slice(0, excess)) {
      try {
        unlinkSync(join(this.dir, f));
      } catch {
        // already gone or locked — ignore
      }
    }
  }
}
