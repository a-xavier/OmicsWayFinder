package omics.cheerp;

import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.Arrays;
import java.util.jar.JarFile;

/**
 * Entry point for every CheerpJ run: connects the standard streams (Stdio), copies the input
 * files into /files/ (Workspace), calls the real main method, then copies the results back.
 *
 *   Launcher <main class> [args...]
 *   Launcher -jar <jar path> [args...]   (main class from the jar's manifest)
 */
public final class Launcher {
    /** Implemented in JavaScript: the run's exit code, since System.exit is turned into an exception. */
    static native void exit(int status);

    public static void main(String[] args) throws Throwable {
        ExitTrap.install();
        System.setProperty("java.io.tmpdir", Workspace.TMP.getPath());
        Stdio.install();
        Workspace workspace = new Workspace();
        int status = 0;
        try {
            workspace.stageIn();
            run(args);
        } catch (ExitTrap.Exit exit) {
            status = exit.status;
        } catch (Throwable error) {
            error.printStackTrace();
            status = 1;
        } finally {
            Stdio.drain();
            try {
                workspace.syncOut();
            } catch (Throwable error) {
                System.err.println("[CheerpJ] Could not copy the results back to the folder: " + error);
                Stdio.drain();
                if (status == 0) status = 1;
            }
        }
        exit(status);
    }

    private static void run(String[] args) throws Throwable {
        if (args.length == 0) throw new IllegalArgumentException("Usage: Launcher <main class> [args...] | -jar <jar> [args...]");
        String mainClass;
        String[] rest;
        ClassLoader loader = Launcher.class.getClassLoader();
        if (args[0].equals("-jar")) {
            if (args.length < 2) throw new IllegalArgumentException("-jar needs a jar path");
            try (JarFile jar = new JarFile(args[1])) {
                mainClass = jar.getManifest() == null ? null : jar.getManifest().getMainAttributes().getValue("Main-Class");
            }
            if (mainClass == null) throw new IllegalArgumentException(args[1] + " has no Main-Class in its manifest");
            // A class loader per jar: the JVM (and its class path) is shared by every run.
            loader = new URLClassLoader(new URL[] { new File(args[1]).toURI().toURL() }, loader);
            rest = Arrays.copyOfRange(args, 2, args.length);
        } else {
            mainClass = args[0];
            rest = Arrays.copyOfRange(args, 1, args.length);
        }
        Thread.currentThread().setContextClassLoader(loader);
        Method main = Class.forName(mainClass.trim(), true, loader).getMethod("main", String[].class);
        try {
            main.invoke(null, (Object) rest);
        } catch (InvocationTargetException error) {
            throw error.getCause();
        }
    }
}
