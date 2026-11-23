package omics.cheerp;

/**
 * The selected folder, as seen from Java. Every method is implemented in JavaScript
 * (cheerpj.ts) on the folder handle; Java waits while each call's promise resolves.
 * Paths are relative to the folder, with "/" separators.
 */
final class Folder {
    private Folder() {}

    /** One line per entry, sorted by name: "d\tname" for a directory, "f\tsize\tname" for a file. */
    static native String list(String path);

    /** Files to copy into /files/ before the run, one path per line (chosen by JavaScript from the arguments). */
    static native String inputs();

    /** Up to `length` bytes of `path` from `offset`; fewer at the end of the file. */
    static native byte[] read(String path, long offset, int length);

    /** Starts writing `path` (parent directories are created). The file is replaced when close() is called. */
    static native void create(String path);

    static native void write(String path, byte[] data, int length);

    static native void close(String path);

    static native void mkdir(String path);
}
