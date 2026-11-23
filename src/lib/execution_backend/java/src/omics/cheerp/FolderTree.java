package omics.cheerp;

/**
 * Prints the selected folder as a tree, like the `tree` command. It walks the real folder
 * through Folder.list(), not the copy in /files/.
 *
 *   FolderTree [path inside the folder]
 */
public final class FolderTree {
    private static int directories;
    private static int files;
    private static long bytes;

    public static void main(String[] args) {
        // The JVM stays alive between runs, so static state must be reset.
        directories = 0;
        files = 0;
        bytes = 0;
        String root = args.length > 0 ? args[0] : "";
        System.out.println(root.isEmpty() ? "." : root);
        print(root, "");
        System.out.println();
        System.out.println(directories + " directories, " + files + " files, " + bytes + " bytes");
    }

    private static void print(String path, String indent) {
        String listing = Folder.list(path);
        String[] entries = listing.isEmpty() ? new String[0] : listing.split("\n");
        for (int i = 0; i < entries.length; i++) {
            boolean last = i == entries.length - 1;
            String[] fields = entries[i].split("\t");
            String name = fields[fields.length - 1];
            if (fields[0].equals("d")) {
                directories++;
                System.out.println(indent + (last ? "└── " : "├── ") + name + "/");
                print(path.isEmpty() ? name : path + "/" + name, indent + (last ? "    " : "│   "));
            } else {
                files++;
                long size = Long.parseLong(fields[1]);
                bytes += size;
                System.out.println(indent + (last ? "└── " : "├── ") + name + " (" + size + " B)");
            }
        }
    }
}
