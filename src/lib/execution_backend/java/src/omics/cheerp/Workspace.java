package omics.cheerp;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.CRC32;

/**
 * Mirrors the selected folder into CheerpJ's /files/ mount around a run. /files/ is Java's
 * working directory, so tools open "reads.bam" as /files/reads.bam with plain java.io or NIO.
 *
 *   stageIn():  clear /files/, copy in the files listed by Folder.inputs()
 *   syncOut():  copy files that are new or changed in /files/ back to the folder, clear /files/
 *
 * A staged file counts as changed if its length or CRC32 differs: CheerpJ cannot set
 * timestamps, and in-place writes do not update them. Files deleted by the tool are not deleted
 * from the folder. Temporary files go to /files/.tmp/ (java.io.tmpdir), which is not copied back.
 */
final class Workspace {
    static final File ROOT = new File("/files");
    static final File TMP = new File(ROOT, ".tmp");
    private static final int CHUNK = 1 << 20;

    /** Path -> "length:crc32" right after staging ("dir" for directories), to spot changes. */
    private final Map<String, String> staged = new HashMap<>();

    void stageIn() throws IOException {
        clear();
        TMP.mkdirs();
        String inputs = Folder.inputs();
        if (inputs.isEmpty()) return;
        for (String path : inputs.split("\n")) {
            File target = new File(ROOT, path);
            target.getParentFile().mkdirs();
            CRC32 crc = new CRC32();
            long offset = 0;
            try (OutputStream out = new FileOutputStream(target)) {
                while (true) {
                    byte[] data = Folder.read(path, offset, CHUNK);
                    if (data.length == 0) break;
                    out.write(data);
                    crc.update(data);
                    offset += data.length;
                }
            }
            staged.put(path, offset + ":" + crc.getValue());
            for (File dir = target.getParentFile(); !dir.equals(ROOT); dir = dir.getParentFile()) staged.put(relative(dir), "dir");
        }
    }

    void syncOut() throws IOException {
        try {
            sync(ROOT);
        } finally {
            clear();
        }
    }

    private void sync(File dir) throws IOException {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            String path = relative(child);
            if (dir.equals(ROOT) && isReserved(child.getName())) continue;
            if (child.isDirectory()) {
                if (!staged.containsKey(path)) Folder.mkdir(path);
                sync(child);
            } else if (changed(child, staged.get(path))) {
                copyOut(child, path);
            }
        }
    }

    private static void copyOut(File file, String path) throws IOException {
        Folder.create(path);
        byte[] buffer = new byte[CHUNK];
        try (InputStream in = new FileInputStream(file)) {
            int count;
            while ((count = in.read(buffer)) > 0) Folder.write(path, buffer, count);
        }
        Folder.close(path);
    }

    /** Empties /files/, keeping CheerpJ's own upload and download folders. */
    static void clear() {
        File[] children = ROOT.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (!isCheerpJFolder(child.getName())) delete(child);
        }
    }

    private static boolean changed(File file, String before) throws IOException {
        if (before == null) return true;
        if (!before.startsWith(file.length() + ":")) return true;
        CRC32 crc = new CRC32();
        byte[] buffer = new byte[CHUNK];
        try (InputStream in = new FileInputStream(file)) {
            int count;
            while ((count = in.read(buffer)) > 0) crc.update(buffer, 0, count);
        }
        return !before.equals(file.length() + ":" + crc.getValue());
    }

    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        file.delete();
    }

    private static boolean isCheerpJFolder(String name) {
        return name.equals("uploads") || name.equals("downloads");
    }

    private static boolean isReserved(String name) {
        return isCheerpJFolder(name) || name.equals(TMP.getName());
    }

    private static String relative(File file) {
        return ROOT.toPath().relativize(file.toPath()).toString().replace(File.separatorChar, '/');
    }
}
