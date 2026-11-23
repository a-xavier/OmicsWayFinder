/** A run's captured stdout and stderr, with a size limit, and stderr sent live to the page. */

/**
 * Most characters of stdout and of stderr kept per run. The whole output is held in memory and
 * copied to the page, so `samtools view big.bam` (gigabytes of SAM text) would crash the tab.
 * Large outputs belong in a file (`-o`) or a pipe.
 */
const OUTPUT_LIMIT = 16 * 1024 * 1024;
/** Least time between two live stderr messages, so chatty tools do not flood the page. */
const LIVE_INTERVAL_MS = 100;

export class RunOutput {
  stdout = "";
  stderr = "";
  private stdoutDropped = 0;
  private stderrDropped = 0;
  private readonly decoder = new TextDecoder();
  private readonly onLiveStderr: ((text: string) => void) | undefined;
  private liveText = "";
  private liveSent = 0;

  /** `onLiveStderr` receives stderr as it is printed, at most every LIVE_INTERVAL_MS. */
  constructor(onLiveStderr?: (text: string) => void) {
    this.onLiveStderr = onLiveStderr;
  }

  writeStdout(text: string): void {
    if (this.stdout.length + text.length <= OUTPUT_LIMIT) this.stdout += text;
    else this.stdoutDropped += text.length;
  }

  /** Binary-safe: a UTF-8 character split across two writes is decoded once complete. */
  writeStdoutBytes(bytes: Uint8Array): void {
    this.writeStdout(this.decoder.decode(bytes, { stream: true }));
  }

  writeStderr(text: string): void {
    if (this.stderr.length + text.length <= OUTPUT_LIMIT) this.stderr += text;
    else this.stderrDropped += text.length;
    if (!this.onLiveStderr) return;
    this.liveText += text;
    if (performance.now() - this.liveSent >= LIVE_INTERVAL_MS) this.sendLive();
  }

  /** End of the run: decode the last bytes, explain dropped output, send the remaining live stderr. */
  finish(): void {
    this.writeStdout(this.decoder.decode());
    for (const [stream, dropped] of [["stdout", this.stdoutDropped], ["stderr", this.stderrDropped]] as const) {
      if (dropped > 0) {
        this.stderr += `[Mayo] ${stream} was cut after ${OUTPUT_LIMIT / 1024 / 1024} MiB; ${dropped} more characters were dropped. Narrow the output (for example samtools view -c, -H or a region) or write it to a file with -o or >.\n`;
      }
    }
    this.sendLive();
  }

  private sendLive(): void {
    if (!this.liveText) return;
    // Posting does not need the worker's event loop, so the page sees it while main() runs.
    this.onLiveStderr?.(this.liveText);
    this.liveText = "";
    this.liveSent = performance.now();
  }
}
