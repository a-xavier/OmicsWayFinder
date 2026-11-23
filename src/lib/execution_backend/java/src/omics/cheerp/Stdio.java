package omics.cheerp;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintStream;

/**
 * Standard streams of a run, connected to JavaScript (cheerpj.ts):
 *   - System.out (fd 1) and System.err (fd 2) go to write() as bytes, to the page or, with
 *     `> file` / `2> file`, straight to a file in the folder.
 *   - System.in reads the `< file` file from the folder, or is empty.
 */
final class Stdio {
    private Stdio() {}

    /** Bytes written to fd 1 or 2. */
    static native void write(int fd, byte[] data, int length);

    /** Whether fd 1 or 2 is redirected to a file (bigger writes, no live output needed). */
    static native boolean redirected(int fd);

    /** The folder path given with `<`, or "" for an empty stdin. */
    static native String stdin();

    private static final int CHUNK = 1 << 20;

    private static NativeOutput out;
    private static NativeOutput err;

    static void install() throws IOException {
        out = new NativeOutput(1, redirected(1));
        err = new NativeOutput(2, redirected(2));
        System.setOut(new PrintStream(out, true, "UTF-8"));
        System.setErr(new PrintStream(err, true, "UTF-8"));
        String path = stdin();
        System.setIn(path.isEmpty() ? InputStream.nullInputStream() : new FolderInput(path));
    }

    /** Sends everything still buffered; call before the run ends. */
    static void drain() {
        System.out.flush();
        System.err.flush();
        out.drain();
        err.drain();
    }

    /**
     * Buffers bytes for write(). Shown on the page: sent at every flush (PrintStream flushes
     * after each println). Redirected to a file: sent in 1 MB blocks.
     */
    private static final class NativeOutput extends OutputStream {
        private final int fd;
        private final boolean redirected;
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();

        NativeOutput(int fd, boolean redirected) {
            this.fd = fd;
            this.redirected = redirected;
        }

        @Override
        public synchronized void write(int b) {
            buffer.write(b);
            if (b == '\n' && !redirected) drain();
        }

        @Override
        public synchronized void write(byte[] bytes, int offset, int length) {
            buffer.write(bytes, offset, length);
            if (buffer.size() >= CHUNK) drain();
        }

        @Override
        public synchronized void flush() {
            if (!redirected) drain();
        }

        synchronized void drain() {
            if (buffer.size() == 0) return;
            byte[] bytes = buffer.toByteArray();
            buffer.reset();
            Stdio.write(fd, bytes, bytes.length);
        }
    }

    /** Reads a folder file in 1 MB blocks through Folder.read. */
    private static final class FolderInput extends InputStream {
        private final String path;
        private long offset;
        private byte[] block = new byte[0];
        private int position;

        FolderInput(String path) {
            this.path = path;
        }

        private boolean fill() {
            if (position < block.length) return true;
            block = Folder.read(path, offset, CHUNK);
            offset += block.length;
            position = 0;
            return block.length > 0;
        }

        @Override
        public synchronized int read() {
            return fill() ? block[position++] & 0xff : -1;
        }

        @Override
        public synchronized int read(byte[] target, int targetOffset, int length) {
            if (length == 0) return 0;
            if (!fill()) return -1;
            int count = Math.min(length, block.length - position);
            System.arraycopy(block, position, target, targetOffset, count);
            position += count;
            return count;
        }
    }
}
