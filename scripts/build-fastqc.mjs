// Package the pinned FastQC release for the CheerpJ launcher.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, unzipSync, zipSync } from "fflate";

const OUT = path.resolve(import.meta.dirname, "../public/java/fastqc/0.13.0");
const RELEASE = {
  url: "https://github.com/s-andrews/FastQC/releases/download/v0.13.0/fastqc_v0.13.0.zip",
  sha256: "c9504d47752e79ecfe61691e09bf367fc3f15167ac3fe83d9e33534fffbcc301",
};
const SOURCE = {
  url: "https://github.com/s-andrews/FastQC/archive/refs/tags/v0.13.0.zip",
  sha256: "f0ac0399ee2a5c49a733a72975e7501daa9fb1f4999acf9e7cd6c7b7f04718b2",
};
const HTSJDK = {
  url: "https://repo.maven.apache.org/maven2/com/github/samtools/htsjdk/2.24.1/htsjdk-2.24.1.jar",
  sha256: "a4301de0e61e20cb44f3972dbde67d130fa5647dc50602308f8367adc0cf17d8",
};
const THIRD_PARTY_SOURCE = {
  "htsjdk-source.jar": {
    url: "https://repo.maven.apache.org/maven2/com/github/samtools/htsjdk/2.24.1/htsjdk-2.24.1-sources.jar",
    sha256: "dbedbe58d9fb74db70529b6f9dcaccb9ecb3a9df5c23b2b19ad21b30fa3e6a2d",
  },
  "commons-compress-source.jar": {
    url: "https://repo.maven.apache.org/maven2/org/apache/commons/commons-compress/1.28.0/commons-compress-1.28.0-sources.jar",
    sha256: "6de9de4559f12bba6d41789c72f6a2a424514f2d2a3f7f49e2a3c52414db9632",
  },
  "commons-io-source.jar": {
    url: "https://repo.maven.apache.org/maven2/commons-io/commons-io/2.22.0/commons-io-2.22.0-sources.jar",
    sha256: "de5acfae5fa2735276df7facf46cdb0347374208ea47db246b554fae59277fb5",
  },
  "LICENSE_LGPL-2.1.txt": {
    url: "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/LGPL-2.1-only.txt",
    sha256: "5749785c8bdefafcb5d798270ed0a967036fe2ca63dcedade1627565dfef81d2",
  },
};
const DEPENDENCIES = ["htsjdk.jar", "commons-compress-1.28.0.jar", "commons-io-2.22.0.jar"];

async function download(release, fetchFile) {
  const response = await fetchFile(release.url);
  if (!response.ok) throw new Error(`${release.url}: HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  const hash = createHash("sha256").update(data).digest("hex");
  if (hash !== release.sha256) throw new Error(`Checksum mismatch for ${release.url}: ${hash}`);
  return data;
}

function patch(text, before, after, name) {
  const index = text.indexOf(before);
  if (index < 0 || text.indexOf(before, index + before.length) !== -1) {
    throw new Error(`Expected exactly one FastQC patch target in ${name}`);
  }
  return text.replace(before, after);
}

export async function buildFastQC(out = OUT, fetchFile = fetch) {
  const [releaseBytes, sourceBytes, htsjdk, ...sourceDependencies] = await Promise.all(
    [RELEASE, SOURCE, HTSJDK, ...Object.values(THIRD_PARTY_SOURCE)].map(item => download(item, fetchFile)),
  );
  const release = unzipSync(releaseBytes);
  const source = unzipSync(sourceBytes);
  const bundledHtsjdk = unzipSync(release["FastQC/htsjdk.jar"]);
  const officialHtsjdk = unzipSync(htsjdk);
  const classNames = Object.keys(bundledHtsjdk).filter(name => name.endsWith(".class"));
  const officialClasses = Object.keys(officialHtsjdk).filter(name => name.endsWith(".class"));
  if (classNames.length !== officialClasses.length || classNames.some(name =>
    !officialHtsjdk[name] || !Buffer.from(bundledHtsjdk[name]).equals(Buffer.from(officialHtsjdk[name])))) {
    throw new Error("FastQC's HTSJDK classes differ from the pinned 2.24.1 release");
  }
  const entries = {};
  for (const [name, data] of Object.entries(release)) {
    const relative = name.slice("FastQC/".length);
    if (/^(uk|org|net|Configuration|Templates)\//.test(relative) && !relative.endsWith("/")) entries[relative] = data;
  }
  for (const required of ["net/sourceforge/iharder/base64/Base64$OutputStream.class", "Templates/Icons/tick.png", "Configuration/limits.txt"]) {
    if (!entries[required]) throw new Error(`FastQC release is missing ${required}`);
  }
  entries["META-INF/MANIFEST.MF"] = strToU8(
    "Manifest-Version: 1.0\r\nMain-Class: FastQCMain\r\n" +
    "Class-Path: htsjdk.jar commons-compress-1.28.0.jar\r\n  commons-io-2.22.0.jar\r\n\r\n",
  );
  const temp = await mkdtemp(path.join(os.tmpdir(), "fastqc-build-"));
  try {
    for (const jar of DEPENDENCIES) {
      const data = jar === "htsjdk.jar" ? htsjdk : release[`FastQC/${jar}`];
      if (!data) throw new Error(`FastQC release is missing ${jar}`);
      await writeFile(path.join(temp, jar), data);
    }
    const classpath = path.join(temp, "fastqc.jar");
    const zipOptions = { mtime: new Date(2000, 0, 1) };
    await writeFile(classpath, zipSync(entries, zipOptions));
    const patchSources = {
      "uk/ac/babraham/FastQC/Analysis/AnalysisQueue.java": [
        ["private volatile int processorsPerFile = 0;", "private volatile int processorsPerFile = 0;\n\tprivate volatile boolean running = true;\n\tpublic void shutdown() { running = false; }"],
        ["Thread t = new Thread(this);\n\t\tt.start();", "Thread t = new Thread(this);\n\t\tt.setDaemon(true);\n\t\tt.start();"],
        ["while (true) {", "while (running) {"],
      ],
      "uk/ac/babraham/FastQC/Analysis/AnalysisRunner.java": [
        ["\tpublic void run() {\n\n\t\tint numProcessors", "\tpublic void run() {\n\t\ttry {\n\t\tint numProcessors"],
        ["\t\trunParallel(numProcessors);\n\t}\n", "\t\trunParallel(numProcessors);\n\t\t} catch (Throwable error) {\n\t\t\tException failure = error instanceof Exception ? (Exception) error : new RuntimeException(\"FastQC worker failed\", error);\n\t\t\tfor (AnalysisListener listener : listeners) listener.analysisExceptionReceived(file, failure);\n\t\t}\n\t}\n"],
      ],
      "uk/ac/babraham/FastQC/FastQCApplication.java": [
        ["new OfflineRunner(args);", "try { new OfflineRunner(args); } finally { uk.ac.babraham.FastQC.Analysis.AnalysisQueue.getInstance().shutdown(); }"],
      ],
      "uk/ac/babraham/FastQC/Report/HTMLReportArchive.java": [
        ['ClassLoader.getSystemResource("Templates/"+path)', 'HTMLReportArchive.class.getClassLoader().getResource("Templates/"+path)'],
      ],
    };
    const sources = [];
    for (const [name, changes] of Object.entries(patchSources)) {
      const bytes = source[`FastQC-0.13.0/${name}`];
      if (!bytes) throw new Error(`FastQC source is missing ${name}`);
      let text = new TextDecoder().decode(bytes).replaceAll("\r\n", "\n");
      for (const [before, after] of changes) text = patch(text, before, after, name);
      source[`FastQC-0.13.0/${name}`] = strToU8(text);
      const file = path.join(temp, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      sources.push(file);
    }
    sources.push(fileURLToPath(new URL("./FastQCMain.java", import.meta.url)));
    execFileSync("javac", ["--release", "17", "-encoding", "UTF-8", "-cp", classpath, "-d", temp, ...sources], { stdio: "inherit" });
    for (const name of [...Object.keys(patchSources).map(name => name.replace(/\.java$/, ".class")), "FastQCMain.class"]) {
      entries[name] = await readFile(path.join(temp, name));
    }
    for (const name of Object.keys(source)) {
      if (name.endsWith(".jar")) delete source[name];
    }
    source["FastQC-0.13.0/omicswayfinder/FastQCMain.java"] = await readFile(fileURLToPath(new URL("./FastQCMain.java", import.meta.url)));
    source["FastQC-0.13.0/omicswayfinder/build-fastqc.mjs"] = await readFile(fileURLToPath(import.meta.url));
    const htsjdkSource = unzipSync(sourceDependencies[0]);
    const samRecord = new TextDecoder().decode(htsjdkSource["htsjdk/samtools/SAMRecord.java"]);
    const licenseEnd = samRecord.indexOf("*/");
    if (licenseEnd < 0 || !samRecord.startsWith("/*")) throw new Error("HTSJDK source license header not found");
    const output = {
      "fastqc.jar": zipSync(entries, zipOptions),
      "source.zip": zipSync(source, zipOptions),
      "LICENSE": release["FastQC/LICENSE"],
      "LICENSE_HTSJDK.txt": strToU8(samRecord.slice(0, licenseEnd + 2)),
      "htsjdk.jar": htsjdk,
      ...Object.fromEntries(DEPENDENCIES.filter(name => name !== "htsjdk.jar").map(name => [name, release[`FastQC/${name}`]])),
      ...Object.fromEntries(Object.keys(THIRD_PARTY_SOURCE).map((name, i) => [name, sourceDependencies[i]])),
    };
    for (const [name, bytes] of Object.entries(output)) {
      if (!bytes) throw new Error(`FastQC release is missing ${name}`);
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, name), bytes);
      console.log(`fastqc/0.13.0/${name} (${bytes.length} bytes)`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildFastQC();
}
