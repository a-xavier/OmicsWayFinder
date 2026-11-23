/**
 * File descriptors 0, 1 and 2 of a tool worker, as a shell sets them up for a process.
 *
 * /dev/stdin and /dev/stdout are replaced by Mayo devices: in a pipeline they are the pipes to
 * the neighbouring stages (pipe/pipe.ts); otherwise stdin is empty and stdout is captured in the
 * run's output. Redirections (`< file`, `> file`, `2> file`) reopen a descriptor on a file.
 */

import { PipeClosedError, PipeReader, PipeWriter } from "../pipe/pipe";
import type { Redirects } from "../../shared/command";
import { errnoError, ERRNO_MESSAGES, type EmscriptenFS } from "./emscripten";
import type { RunOutput } from "./output";

// Device numbers for Mayo's stdin and stdout (any major number Emscripten does not use).
const DEVICE_MAJOR = 64;

/** Thrown out of main() when stdout's reader has gone, ending the program as SIGPIPE would. */
class BrokenPipe extends Error {}

export class Stdio {
  private readonly FS: EmscriptenFS;
  private stdin: PipeReader | undefined;
  private stdout: PipeWriter | undefined;
  private output: RunOutput | undefined;
  /** Set when the program wrote to a pipe whose reader had exited. */
  brokenPipe = false;

  constructor(FS: EmscriptenFS) {
    this.FS = FS;
    this.installDevices();
  }

  /** Connect a run's pipes (SharedArrayBuffers from the coordinator) and output. */
  begin(output: RunOutput, stdin: SharedArrayBuffer | undefined, stdout: SharedArrayBuffer | undefined): void {
    this.output = output;
    this.stdin = stdin ? new PipeReader(stdin) : undefined;
    this.stdout = stdout ? new PipeWriter(stdout) : undefined;
    this.brokenPipe = false;
  }

  /**
   * Point stdin, stdout and/or stderr at files, relative to the working directory, like a shell's
   * `<`, `>`, `>>` and `2>`. Returns a shell-style error message if a file cannot be opened.
   */
  redirect(redirects: Redirects): string | undefined {
    const FS = this.FS;
    for (const { fd, path, flags } of redirectTargets(redirects)) {
      if (!path) continue;
      try {
        FS.close(FS.streams[fd]);
        const stream = FS.open(path, flags);
        if (stream.fd !== fd) {
          FS.close(stream);
          throw new Error(`could not use it as descriptor ${fd}`);
        }
      } catch (error) {
        const errno = (error as { errno?: number }).errno;
        const message = errno !== undefined
          ? ERRNO_MESSAGES[errno] ?? `error ${errno}`
          : error instanceof Error ? error.message : String(error);
        return `mayo: ${path}: ${message}`;
      }
    }
    return undefined;
  }

  /** Close the pipe ends: end of file for the next stage, EPIPE for the previous one, as when a process exits. */
  closePipes(): void {
    this.stdout?.close();
    this.stdin?.close();
    this.stdin = undefined;
    this.stdout = undefined;
  }

  /**
   * Close descriptors 0, 1 and 2 (closing a redirection file saves it) and reopen them on the
   * devices for the next run. Returns the files that could not be saved.
   */
  reset(redirects: Redirects = {}): string[] {
    const FS = this.FS;
    const errors: string[] = [];
    for (const { fd, path } of redirectTargets(redirects)) {
      const stream = FS.streams[fd];
      if (!stream) continue;
      try {
        FS.close(stream);
      } catch (error) {
        if (path) errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        FS.streams[fd] = null;
      }
    }
    // open() takes the lowest free descriptor.
    FS.open("/dev/stdin", "r");
    FS.open("/dev/stdout", "w");
    FS.open("/dev/stderr", "w");
    this.output = undefined;
    return errors;
  }

  /** Replace /dev/stdin and /dev/stdout with devices that read and write the run's pipes. */
  private installDevices(): void {
    const FS = this.FS;
    const badDescriptor = () => {
      throw errnoError(FS, "EBADF");
    };
    // No llseek: Emscripten answers ESPIPE, so programs see a pipe, not a seekable file.
    const stdinDevice = FS.makedev(DEVICE_MAJOR, 0);
    FS.registerDevice(stdinDevice, {
      open() {},
      close() {},
      read: (_stream: unknown, buffer: Int8Array, offset: number, length: number): number =>
        this.stdin ? this.stdin.read(buffer, offset, length) : 0,
      write: badDescriptor,
    });
    const stdoutDevice = FS.makedev(DEVICE_MAJOR, 1);
    FS.registerDevice(stdoutDevice, {
      open() {},
      close() {},
      read: badDescriptor,
      write: (_stream: unknown, buffer: Int8Array, offset: number, length: number): number => {
        const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
        if (!this.stdout) {
          this.output?.writeStdoutBytes(bytes);
          return length;
        }
        try {
          this.stdout.write(bytes);
        } catch (error) {
          if (!(error instanceof PipeClosedError)) throw error;
          this.brokenPipe = true;
          throw new BrokenPipe("Broken pipe");
        }
        return length;
      },
    });
    FS.unlink("/dev/stdin");
    FS.mkdev("/dev/stdin", 0o666, stdinDevice);
    FS.unlink("/dev/stdout");
    FS.mkdev("/dev/stdout", 0o666, stdoutDevice);
    this.reset();
  }
}

/** Descriptors 0, 1 and 2 with their redirection file (if any) and open() flags. */
function redirectTargets(redirects: Redirects): { fd: number; path: string | undefined; flags: string }[] {
  return [
    { fd: 0, path: redirects.stdin, flags: "r" },
    { fd: 1, path: redirects.stdout?.path, flags: redirects.stdout?.append ? "a" : "w" },
    { fd: 2, path: redirects.stderr?.path, flags: redirects.stderr?.append ? "a" : "w" },
  ];
}
