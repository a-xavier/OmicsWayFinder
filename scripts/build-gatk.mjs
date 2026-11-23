// Builds public/java/gatk/<version>/gatk.jar: GATK from Maven Central merged with only the
// dependency jars it really loads (about 60 of 365 jars, 78 of 375 MB). See
// public/java/gatk/README.md.
//
//   node scripts/build-gatk.mjs          # merge the jars listed in jars.txt
//   node scripts/build-gatk.mjs trace    # list the jars again: run trace-commands.txt on the full
//                                        # classpath, rewrite jars.txt, check the merged jar gives
//                                        # the same outputs
//
// Needs Java 17+ (JAVA_HOME, or java on the PATH). Uses mvn from the PATH, or downloads Maven.
// Downloads and test data go to node_modules/.cache/gatk/ (not public/, which the site serves).
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const RECIPE = resolve(import.meta.dirname, "../public/java/gatk");
const CACHE = resolve(import.meta.dirname, "../node_modules/.cache/gatk");
const FULL = join(CACHE, "full");
const DATA = join(CACHE, "data");
const JARS = join(RECIPE, "jars.txt");
const ORDER = join(CACHE, "classpath.txt");
const MAVEN_VERSION = "3.9.9";
const MAVEN_URL = `https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz`;
const MAIN = "org.broadinstitute.hellbender.Main";

const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java";
const version = /<artifactId>gatk<\/artifactId>\s*<version>([^<]+)</.exec(readFileSync(join(RECIPE, "pom.xml"), "utf8"))[1];

function lines(path) {
  return readFileSync(path, "utf8").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));
}

function megabytes(paths) {
  return (paths.reduce((sum, path) => sum + statSync(path).size, 0) / 2 ** 20).toFixed(1);
}

/**
 * The jars in Maven's classpath order (GATK first, then its dependencies as declared). With a fixed
 * order, the jar a class comes from when two jars have it (log4j 1 in reload4j and log4j-1.2-api,
 * for example) is the same on every machine (`-cp 'dir/*'` would follow the directory's order),
 * and MergeJars keeps that same one.
 */
function classpath(names) {
  const order = readFileSync(ORDER, "utf8").split(":").map(path => basename(path.trim()));
  return [...names].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

function maven() {
  if (spawnSync("mvn", ["-v"]).status === 0) return "mvn";
  const local = join(CACHE, `apache-maven-${MAVEN_VERSION}`, "bin", "mvn");
  if (!existsSync(local)) {
    mkdirSync(CACHE, { recursive: true });
    console.log(`Downloading Maven ${MAVEN_VERSION}`);
    execFileSync("sh", ["-c", `curl -sfL "${MAVEN_URL}" | tar xz -C "${CACHE}"`], { stdio: "inherit" });
  }
  return local;
}

/** GATK and all its runtime dependencies, in node_modules/.cache/gatk/full/. */
function resolveFull() {
  rmSync(FULL, { recursive: true, force: true });
  const mvn = maven();
  const pom = ["-q", "-B", "-f", join(RECIPE, "pom.xml")];
  execFileSync(mvn, [...pom, "dependency:copy-dependencies", "-DincludeScope=runtime", `-DoutputDirectory=${FULL}`], { stdio: "inherit" });
  execFileSync(mvn, [...pom, "dependency:build-classpath", "-DincludeScope=runtime", `-Dmdep.outputFile=${ORDER}`], { stdio: "inherit" });
  const jars = readdirSync(FULL);
  console.log(`Full classpath: ${jars.length} jars, ${megabytes(jars.map(name => join(FULL, name)))} MB`);
}

/** Runs GATK in the test data folder on the given jars; with `classes`, logs every class loaded to that file. */
function gatk(jars, args, log, classes) {
  const options = classes ? [`-Xlog:class+load=info:file=${classes}`] : [];
  const result = spawnSync(java, ["-Xmx2g", ...options, "-cp", jars.join(":"), MAIN, ...args], { cwd: DATA, encoding: "utf8" });
  writeFileSync(log, result.stdout + result.stderr);
  if (result.status !== 0) throw new Error(`GATK ${args.join(" ")} failed (exit ${result.status}), see ${log}`);
}

/**
 * A small sample whose answer is known: two random contigs, SNPs every 4 kb (some homozygous) and a
 * 3 bp heterozygous deletion per contig, 30x of 150 bp reads written already aligned (no aligner
 * needed), then made into an indexed BAM, a .fai and a .dict.
 */
function makeTestData() {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  let seed = 1;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const base = () => "ACGT"[Math.floor(random() * 4)];
  const contigs = [["chrA", 60000], ["chrB", 40000]];
  const READ = 150;
  const DELETION = 3;
  let fasta = "";
  let fai = "";
  const header = ["@HD\tVN:1.6\tSO:coordinate"];
  const records = [];
  for (const [name, length] of contigs) {
    const ref = Array.from({ length }, base);
    fai += `${name}\t${length}\t${fasta.length + name.length + 2}\t60\t61\n`;
    fasta += `>${name}\n${ref.join("").match(/.{1,60}/g).join("\n")}\n`;
    header.push(`@SQ\tSN:${name}\tLN:${length}`);
    const haplotypes = [[...ref], [...ref]];
    for (let pos = 2000; pos < length - 2000; pos += 4000) {
      const alt = "ACGT".replace(ref[pos], "")[Math.floor(random() * 3)];
      haplotypes[0][pos] = alt;
      if (random() < 0.4) haplotypes[1][pos] = alt;
    }
    const deletion = Math.floor(length / 2) + 7;
    haplotypes[0].splice(deletion, DELETION);
    haplotypes.forEach((haplotype, index) => {
      for (let i = 0; i < (length * 30) / (2 * READ); i++) {
        const start = Math.floor(random() * (haplotype.length - READ));
        const sequence = haplotype.slice(start, start + READ).join("");
        // Haplotype 0 lacks DELETION bases at `deletion`: map its positions back to the reference.
        let refStart = start;
        let cigar = `${READ}M`;
        if (index === 0 && start >= deletion) refStart = start + DELETION;
        else if (index === 0 && start + READ > deletion && start < deletion) {
          cigar = `${deletion - start}M${DELETION}D${READ - (deletion - start)}M`;
        }
        records.push([name, refStart + 1, `${sequence}\t${"I".repeat(READ)}`, cigar]);
      }
    });
  }
  header.push("@RG\tID:s1\tSM:sample1\tPL:ILLUMINA");
  const order = new Map(contigs.map(([name], index) => [name, index]));
  records.sort((a, b) => order.get(a[0]) - order.get(b[0]) || a[1] - b[1]);
  const sam = records.map(([name, pos, rest, cigar], i) => `r${i}\t0\t${name}\t${pos}\t60\t${cigar}\t*\t0\t0\t${rest}\tRG:Z:s1`);
  writeFileSync(join(DATA, "ref.fa"), fasta);
  writeFileSync(join(DATA, "ref.fa.fai"), fai);
  writeFileSync(join(DATA, "reads.sam"), `${header.join("\n")}\n${sam.join("\n")}\n`);
  const full = classpath(readdirSync(FULL)).map(name => join(FULL, name));
  gatk(full, ["CreateSequenceDictionary", "-R", "ref.fa", "-O", "ref.dict"], join(CACHE, "make-dict.log"));
  gatk(full, ["SortSam", "-I", "reads.sam", "-O", "reads.bam", "-SO", "coordinate", "--CREATE_INDEX", "true"], join(CACHE, "make-bam.log"));
  console.log(`Test data: ${records.length} reads in ${DATA}`);
}

/** Every trace command, with the tool list first. Returns the outputs of the run, by file name. */
function runCommands(jars, label, onRun) {
  const logs = join(CACHE, label);
  rmSync(logs, { recursive: true, force: true });
  mkdirSync(logs, { recursive: true });
  rmSync(join(DATA, "out"), { recursive: true, force: true });
  mkdirSync(join(DATA, "out"));
  const commands = [[], ...lines(join(RECIPE, "trace-commands.txt")).map(line => line.split(/\s+/))];
  commands.forEach((args, index) => {
    const name = `${index}-${args[0] ?? "list"}`;
    const classes = onRun ? join(logs, `${name}.classes`) : undefined;
    gatk(jars, args, join(logs, `${name}.log`), classes);
    console.log(`  ${label}: ${args.join(" ") || "(tool list)"}`);
    if (classes) onRun(classes);
  });
  const outputs = readdirSync(join(DATA, "out")).filter(name => !/\.(bai|idx|tbi)$/.test(name));
  return Object.fromEntries(outputs.map(name => [name, comparable(join(DATA, "out", name))]));
}

/**
 * An output's content without what changes between runs (headers with dates and command lines).
 * Indexes are skipped: they hold byte offsets, which move with the header.
 */
function comparable(path) {
  let bytes = readFileSync(path);
  if (/\.(gz|bam)$/.test(path)) bytes = gunzipSync(bytes);
  if (path.endsWith(".bam")) return bytes.toString("base64");
  return bytes.toString("utf8").split("\n").filter(line => !line.startsWith("#") && !line.startsWith("@")).join("\n");
}

function trace() {
  makeTestData();
  const used = new Set();
  const all = classpath(readdirSync(FULL));
  const full = runCommands(all.map(name => join(FULL, name)), "trace-full", classes => {
    for (const match of readFileSync(classes, "utf8").matchAll(/source: (?:jar:)?file:(\S+?\.jar)/g)) used.add(basename(match[1]));
  });
  const jars = all.filter(name => used.has(name));
  writeFileSync(JARS, `# Jars GATK ${version} loaded while running trace-commands.txt, in classpath order (written by \`npm run build:gatk -- trace\`).\n${jars.join("\n")}\n`);
  console.log(`Wrote jars.txt: ${jars.length} jars, ${megabytes(jars.map(name => join(FULL, name)))} MB`);
  const merged = join(CACHE, "gatk.jar");
  merge(merged);
  const outputs = runCommands([merged], "trace-merged");
  const different = Object.keys(full).filter(name => full[name] !== outputs[name]);
  if (different.length) throw new Error(`The merged jar gave different outputs: ${different.join(", ")}`);
  console.log(`Same ${Object.keys(full).length} outputs with the merged jar.`);
}

/** Merges the jars in jars.txt, in its order, into `out`. */
function merge(out) {
  const jars = lines(JARS);
  const missing = jars.filter(name => !existsSync(join(FULL, name)));
  if (missing.length) throw new Error(`Not in the full classpath (GATK version changed? run trace): ${missing.join(", ")}`);
  execFileSync(java, [join(import.meta.dirname, "MergeJars.java"), out, ...jars.map(name => join(FULL, name))], { stdio: "inherit" });
}

const command = process.argv[2] ?? "build";
if (command !== "build" && command !== "trace") {
  console.error("Usage: node scripts/build-gatk.mjs [trace]");
  process.exit(1);
}
resolveFull();
if (command === "trace") trace();
else merge(join(CACHE, "gatk.jar"));
const out = join(RECIPE, version);
mkdirSync(out, { recursive: true });
copyFileSync(join(CACHE, "gatk.jar"), join(out, "gatk.jar"));
console.log(`Wrote public/java/gatk/${version}/gatk.jar: ${megabytes([join(out, "gatk.jar")])} MB`);
