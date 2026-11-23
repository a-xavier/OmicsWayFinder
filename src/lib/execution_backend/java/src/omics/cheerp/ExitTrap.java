package omics.cheerp;

import java.security.Permission;

/**
 * Turns System.exit(status) into an exception, so a tool that exits does not stop the JVM
 * before Launcher copies its output files back. Uses the SecurityManager, which Java 17 still
 * allows (deprecated; removed in Java 24, where another approach will be needed).
 */
@SuppressWarnings("removal")
final class ExitTrap extends SecurityManager {
    static final class Exit extends SecurityException {
        final int status;

        Exit(int status) {
            super("System.exit(" + status + ")");
            this.status = status;
        }
    }

    static void install() {
        if (!(System.getSecurityManager() instanceof ExitTrap)) System.setSecurityManager(new ExitTrap());
    }

    @Override
    public void checkExit(int status) {
        throw new Exit(status);
    }

    @Override
    public void checkPermission(Permission permission) {}

    @Override
    public void checkPermission(Permission permission, Object context) {}
}
