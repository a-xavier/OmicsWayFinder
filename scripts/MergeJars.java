import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.jar.*;
import java.util.zip.*;

/**
 * Merges jars into one, as the JVM would see them on a classpath in the given order:
 * java scripts/MergeJars.java out.jar first.jar second.jar ...
 *
 * - An entry in several jars is taken from the first one (the JVM loads a class from the first
 *   jar on the classpath that has it).
 * - The manifest is the first jar's, plus a section per package of the other jars with their
 *   Implementation and Specification attributes, so Package.getImplementationVersion() is
 *   unchanged (Picard writes its version into the BAMs it makes).
 * - META-INF/services files are joined (ServiceLoader reads them from every jar).
 * - Log4j2 plugin caches are merged (log4j-core reads them from every jar).
 * - module-info.class and signature files are dropped: they describe one jar, not the merge.
 *
 * Runs on the zip streams, never on disk: some class names differ only by case, which a
 * case-insensitive file system (macOS) would merge. Entries get a fixed time, so the output is
 * byte for byte the same on every build.
 */
public class MergeJars {
  static final String SERVICES = "META-INF/services/";
  static final String PLUGINS = "META-INF/org/apache/logging/log4j/core/config/plugins/Log4j2Plugins.dat";

  public static void main(String[] args) throws IOException {
    var entries = new LinkedHashMap<String, byte[]>();
    var services = new LinkedHashMap<String, LinkedHashSet<String>>();
    var plugins = new LinkedHashMap<String, LinkedHashMap<String, String[]>>();
    Manifest manifest = null;
    int duplicates = 0;
    for (int i = 1; i < args.length; i++) {
      Attributes versions = null;
      try (var in = new JarInputStream(new BufferedInputStream(Files.newInputStream(Path.of(args[i]))))) {
        if (in.getManifest() != null) {
          if (manifest == null) manifest = in.getManifest();
          else versions = versions(in.getManifest().getMainAttributes());
        }
        for (ZipEntry entry; (entry = in.getNextEntry()) != null; ) {
          String name = entry.getName();
          if (entry.isDirectory() || dropped(name)) continue;
          byte[] bytes = in.readAllBytes();
          int slash = name.lastIndexOf('/');
          if (versions != null && name.endsWith(".class") && slash > 0 && !name.startsWith("META-INF/")) {
            manifest.getEntries().putIfAbsent(name.substring(0, slash + 1), versions);
          }
          if (name.startsWith(SERVICES)) {
            var lines = services.computeIfAbsent(name, k -> new LinkedHashSet<>());
            for (String line : new String(bytes, "UTF-8").split("\r?\n")) {
              line = line.replaceAll("#.*", "").trim();
              if (!line.isEmpty()) lines.add(line);
            }
          } else if (name.equals(PLUGINS)) {
            readPlugins(bytes, plugins);
          } else if (entries.putIfAbsent(name, bytes) != null) {
            duplicates++;
          }
        }
      }
    }
    for (var service : services.entrySet()) {
      entries.put(service.getKey(), (String.join("\n", service.getValue()) + "\n").getBytes("UTF-8"));
    }
    if (!plugins.isEmpty()) entries.put(PLUGINS, writePlugins(plugins));
    if (manifest != null) {
      var bytes = new ByteArrayOutputStream();
      manifest.write(bytes);
      entries.put("META-INF/MANIFEST.MF", bytes.toByteArray());
    }

    try (var out = new ZipOutputStream(new BufferedOutputStream(Files.newOutputStream(Path.of(args[0]))))) {
      // The manifest first, as java.util.jar.JarInputStream expects.
      var names = new ArrayList<>(entries.keySet());
      names.sort(Comparator.comparing(name -> !name.equals("META-INF/MANIFEST.MF")));
      var directories = new HashSet<String>();
      for (String name : names) {
        for (int slash = name.indexOf('/'); slash >= 0; slash = name.indexOf('/', slash + 1)) {
          String directory = name.substring(0, slash + 1);
          if (directories.add(directory)) out.putNextEntry(entry(directory));
        }
        out.putNextEntry(entry(name));
        out.write(entries.get(name));
      }
    }
    System.out.printf("Merged %d jars: %d entries, %d duplicates skipped%n", args.length - 1, entries.size(), duplicates);
  }

  /** An entry with a fixed time, so the same jars always give the same bytes. */
  static ZipEntry entry(String name) {
    var entry = new ZipEntry(name);
    entry.setTimeLocal(java.time.LocalDateTime.of(2000, 1, 1, 0, 0));
    return entry;
  }

  /** A jar's Implementation-* and Specification-* attributes, or null if it has none. */
  static Attributes versions(Attributes main) {
    var versions = new Attributes();
    for (var attribute : main.entrySet()) {
      String key = attribute.getKey().toString();
      if (key.startsWith("Implementation-") || key.startsWith("Specification-")) versions.put(attribute.getKey(), attribute.getValue());
    }
    return versions.isEmpty() ? null : versions;
  }

  static boolean dropped(String name) {
    return name.equals("META-INF/MANIFEST.MF")
        || name.endsWith("module-info.class")
        || name.matches("META-INF/[^/]+\\.(SF|RSA|DSA|EC)")
        || name.equals("META-INF/INDEX.LIST");
  }

  // Log4j2Plugins.dat (log4j-core's PluginCache): category count, then per category its name,
  // entry count and entries (key, class name, plugin name, printable, defer).
  static void readPlugins(byte[] bytes, Map<String, LinkedHashMap<String, String[]>> plugins) throws IOException {
    var in = new DataInputStream(new ByteArrayInputStream(bytes));
    for (int categories = in.readInt(); categories > 0; categories--) {
      var category = plugins.computeIfAbsent(in.readUTF(), k -> new LinkedHashMap<>());
      for (int count = in.readInt(); count > 0; count--) {
        String key = in.readUTF();
        String[] entry = { in.readUTF(), in.readUTF(), String.valueOf(in.readBoolean()), String.valueOf(in.readBoolean()) };
        category.putIfAbsent(key, entry);
      }
    }
  }

  static byte[] writePlugins(Map<String, LinkedHashMap<String, String[]>> plugins) throws IOException {
    var bytes = new ByteArrayOutputStream();
    var out = new DataOutputStream(bytes);
    out.writeInt(plugins.size());
    for (var category : plugins.entrySet()) {
      out.writeUTF(category.getKey());
      out.writeInt(category.getValue().size());
      for (var entry : category.getValue().entrySet()) {
        String[] value = entry.getValue();
        out.writeUTF(entry.getKey());
        out.writeUTF(value[0]);
        out.writeUTF(value[1]);
        out.writeBoolean(Boolean.parseBoolean(value[2]));
        out.writeBoolean(Boolean.parseBoolean(value[3]));
      }
    }
    out.flush();
    return bytes.toByteArray();
  }
}
