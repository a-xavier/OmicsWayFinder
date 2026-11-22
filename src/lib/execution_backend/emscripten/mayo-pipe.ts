/**
 * A Unix-style pipe between two workers: a ring buffer in a SharedArrayBuffer.
 *
 * One worker writes (the upstream tool's stdout), another reads (the downstream tool's stdin).
 * Both block with Atomics.wait, so they must run in workers. The writer waits while the buffer
 * is full and the reader waits while it is empty, so memory use is fixed however much data
 * flows through, and both tools run at the same time.
 *
 * - read() returns 0 (end of file) once the buffer is empty and the writer has closed.
 * - write() throws PipeClosedError (EPIPE) once the reader has closed.
 * - closePipe() closes both ends from outside, for a tool that crashed or was cancelled.
 *
 * Every state change increments SEQ and notifies it. Waiters read SEQ before checking the state
 * and wait only while it is unchanged, so a change made between the check and the wait is never
 * missed.
 */

// Int32 header slots. Counters wrap around; (written - read) | 0 stays correct while
// the capacity is below 2^31, and positions modulo a power-of-two capacity stay correct.
const WRITTEN = 0;
const READ = 1;
const WRITER_CLOSED = 2;
const READER_CLOSED = 3;
const SEQ = 4;
const HEADER_BYTES = 32;

/** Default capacity: large enough that tools rarely wait on each other, small enough to keep memory bounded. */
export const PIPE_CAPACITY = 1024 * 1024;

/** The reader has closed its end: the writer gets EPIPE (a shell would send SIGPIPE). */
export class PipeClosedError extends Error {
  constructor() {
    super("Broken pipe");
    this.name = "PipeClosedError";
  }
}

/** Shared memory for a new pipe; pass it to PipeWriter and PipeReader in two workers. */
export function createPipe(capacity = PIPE_CAPACITY): SharedArrayBuffer {
  // The counters wrap at 2^32, so positions stay consistent only if the capacity divides it.
  if (capacity <= 0 || capacity > 2 ** 30 || (capacity & (capacity - 1)) !== 0) {
    throw new RangeError("Pipe capacity must be a power of two up to 1 GiB.");
  }
  return new SharedArrayBuffer(HEADER_BYTES + capacity);
}

/** Close both ends: the reader sees end of file and the writer gets EPIPE. Safe to call twice. */
export function closePipe(buffer: SharedArrayBuffer): void {
  const header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
  Atomics.store(header, WRITER_CLOSED, 1);
  Atomics.store(header, READER_CLOSED, 1);
  signal(header);
}

function signal(header: Int32Array): void {
  Atomics.add(header, SEQ, 1);
  Atomics.notify(header, SEQ);
}

class PipeEnd {
  protected readonly header: Int32Array;
  protected readonly data: Uint8Array;
  protected readonly capacity: number;

  constructor(buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, HEADER_BYTES / 4);
    this.data = new Uint8Array(buffer, HEADER_BYTES);
    this.capacity = this.data.byteLength;
  }

  protected buffered(): number {
    return (Atomics.load(this.header, WRITTEN) - Atomics.load(this.header, READ)) | 0;
  }
}

export class PipeWriter extends PipeEnd {
  /** Write all bytes, waiting while the buffer is full. Throws PipeClosedError if the reader closes. */
  write(bytes: Uint8Array): void {
    let done = 0;
    while (done < bytes.byteLength) {
      const seq = Atomics.load(this.header, SEQ);
      if (Atomics.load(this.header, READER_CLOSED)) throw new PipeClosedError();
      if (Atomics.load(this.header, WRITER_CLOSED)) throw new PipeClosedError();
      const free = this.capacity - this.buffered();
      if (free === 0) {
        Atomics.wait(this.header, SEQ, seq);
        continue;
      }
      const count = Math.min(free, bytes.byteLength - done);
      const written = Atomics.load(this.header, WRITTEN);
      const start = (written >>> 0) % this.capacity;
      const first = Math.min(count, this.capacity - start);
      this.data.set(bytes.subarray(done, done + first), start);
      if (first < count) this.data.set(bytes.subarray(done + first, done + count), 0);
      Atomics.store(this.header, WRITTEN, (written + count) | 0);
      signal(this.header);
      done += count;
    }
  }

  /** The reader sees end of file after the data already written. */
  close(): void {
    Atomics.store(this.header, WRITER_CLOSED, 1);
    signal(this.header);
  }
}

export class PipeReader extends PipeEnd {
  /**
   * Copy up to `length` bytes into `target` at `offset`, waiting until some data is available.
   * Returns fewer bytes than asked when less is buffered, like read() on a pipe; 0 at end of file.
   */
  read(target: Uint8Array | Int8Array, offset: number, length: number): number {
    if (length === 0) return 0;
    for (;;) {
      const seq = Atomics.load(this.header, SEQ);
      const available = this.buffered();
      if (available > 0) {
        const count = Math.min(available, length);
        const read = Atomics.load(this.header, READ);
        const start = (read >>> 0) % this.capacity;
        const first = Math.min(count, this.capacity - start);
        const out = new Uint8Array(target.buffer, target.byteOffset + offset, count);
        out.set(this.data.subarray(start, start + first));
        if (first < count) out.set(this.data.subarray(0, count - first), first);
        Atomics.store(this.header, READ, (read + count) | 0);
        signal(this.header);
        return count;
      }
      if (Atomics.load(this.header, WRITER_CLOSED) || Atomics.load(this.header, READER_CLOSED)) return 0;
      Atomics.wait(this.header, SEQ, seq);
    }
  }

  /** Stop reading: further writes fail with EPIPE, as when a program like `head` exits early. */
  close(): void {
    Atomics.store(this.header, READER_CLOSED, 1);
    signal(this.header);
  }
}
