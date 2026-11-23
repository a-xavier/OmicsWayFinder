// Compiles the helper classes in src/lib/execution_backend/java/src into public/java/omics-cheerp.jar,
// which CheerpJ loads as /app/java/omics-cheerp.jar. Needs a JDK (javac and jar) on the PATH.
// The jar is committed, so the site builds without a JDK; rerun this after editing the Java code.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE = "src/lib/execution_backend/java/src";
const JAR = "public/java/omics-cheerp.jar";
// CheerpJ runs Java 8 to 25; the app starts Java 17 (cheerpjInit({ version: 17 })).
const RELEASE = "17";

function javaFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return javaFiles(path);
    return entry.name.endsWith(".java") ? [path] : [];
  });
}

const classes = mkdtempSync(join(tmpdir(), "omics-cheerp-"));
try {
  execFileSync("javac", ["--release", RELEASE, "-encoding", "UTF-8", "-d", classes, ...javaFiles(SOURCE)], { stdio: "inherit" });
  mkdirSync("public/java", { recursive: true });
  rmSync(JAR, { force: true });
  execFileSync("jar", ["--create", "--file", JAR, "-C", classes, "."], { stdio: "inherit" });
  console.log(`Wrote ${JAR}`);
} finally {
  rmSync(classes, { recursive: true, force: true });
}
