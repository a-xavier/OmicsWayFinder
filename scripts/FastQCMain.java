import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import uk.ac.babraham.FastQC.FastQCApplication;

/** Command-line adapter for the browser build of FastQC. */
public final class FastQCMain {
    public static void main(String[] args) {
        Map<String, String> previous = new LinkedHashMap<>();
        try {
            run(args, previous);
        } finally {
            for (Map.Entry<String, String> entry : previous.entrySet()) {
                if (entry.getValue() == null) System.clearProperty(entry.getKey());
                else System.setProperty(entry.getKey(), entry.getValue());
            }
        }
    }

    private static void run(String[] args, Map<String, String> previous) {
        ArrayList<String> files = new ArrayList<>();
        set(previous, "fastqc.threads", "1");
        set(previous, "user.home", "/files/.tmp");
        set(previous, "java.awt.headless", "true");
        boolean positional = false;
        int minLength = 0;
        int maxLength = 0;
        for (int i = 0; i < args.length; i++) {
            String arg = args[i];
            if (!positional && arg.equals("--")) {
                positional = true;
            } else if (!positional && (arg.equals("-h") || arg.equals("--help"))) {
                System.out.println("Usage: fastqc [--outdir DIR] [--threads 1] [--quiet] [--extract] [--phred64] [--nogroup] [--png] [--contaminants FILE] [--adapters FILE] [--limits FILE] [--format FORMAT] [--min_length N] [--max_length N] [--dup_length N] FILE...");
                return;
            } else if (!positional && (arg.equals("-v") || arg.equals("--version"))) {
                System.out.println("FastQC v" + FastQCApplication.VERSION);
                return;
            } else if (!positional && (arg.equals("-q") || arg.equals("--quiet"))) {
                set(previous, "fastqc.quiet", "true");
            } else if (!positional && arg.equals("--extract")) {
                set(previous, "fastqc.unzip", "true");
            } else if (!positional && arg.equals("--phred64")) {
                set(previous, "fastqc.phred64", "true");
            } else if (!positional && arg.equals("--nogroup")) {
                set(previous, "fastqc.nogroup", "true");
            } else if (!positional && arg.equals("--png")) {
                set(previous, "fastqc.svg", "false");
            } else if (!positional && arg.startsWith("-")) {
                if (!List.of("-t", "--threads", "-o", "--outdir", "-c", "--contaminants", "-a", "--adapters",
                    "-l", "--limits", "-f", "--format", "--min_length", "--max_length", "--dup_length").contains(arg)) {
                    throw new IllegalArgumentException("Unsupported FastQC option: " + arg);
                }
                if (++i == args.length) throw new IllegalArgumentException("Missing value for " + arg);
                String value = args[i];
                switch (arg) {
                    case "-t": case "--threads":
                        if (!value.equals("1")) throw new IllegalArgumentException("FastQC currently supports only --threads 1");
                        break;
                    case "-o": case "--outdir":
                        File dir = new File(value);
                        if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalArgumentException("Cannot create output directory: " + value);
                        set(previous, "fastqc.output_dir", value);
                        break;
                    case "-c": case "--contaminants": set(previous, "fastqc.contaminant_file", value); break;
                    case "-a": case "--adapters": set(previous, "fastqc.adapter_file", value); break;
                    case "-l": case "--limits": set(previous, "fastqc.limits_file", value); break;
                    case "-f": case "--format": set(previous, "fastqc.sequence_format", value); break;
                    case "--min_length": case "--max_length": case "--dup_length":
                        if (Integer.parseInt(value) < 1) throw new IllegalArgumentException(arg + " must be positive");
                        if (arg.equals("--min_length")) minLength = Integer.parseInt(value);
                        if (arg.equals("--max_length")) maxLength = Integer.parseInt(value);
                        set(previous, "fastqc." + arg.substring(2), value);
                        break;
                    default: throw new IllegalArgumentException("Unsupported FastQC option: " + arg);
                }
            } else {
                if (arg.toLowerCase(java.util.Locale.ROOT).endsWith(".fast5")) {
                    throw new IllegalArgumentException("FAST5 input is not supported by this FastQC build");
                }
                if (!arg.equals("stdin") && (!new File(arg).isFile() || !new File(arg).canRead())) {
                    throw new IllegalArgumentException("Input file does not exist or cannot be read: " + arg);
                }
                files.add(arg);
            }
        }
        if (minLength > 0 && maxLength > 0 && minLength > maxLength) {
            throw new IllegalArgumentException("--min_length must not exceed --max_length");
        }
        if (files.isEmpty()) throw new IllegalArgumentException("FastQC needs at least one input file");
        FastQCApplication.main(files.toArray(new String[0]));
    }

    private static void set(Map<String, String> previous, String name, String value) {
        if (!previous.containsKey(name)) previous.put(name, System.getProperty(name));
        System.setProperty(name, value);
    }
}
