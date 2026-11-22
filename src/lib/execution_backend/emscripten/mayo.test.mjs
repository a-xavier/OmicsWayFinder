import assert from "node:assert/strict";
import test from "node:test";
import { parseCommand, parsePipeline } from "./mayo.ts";

test("parses a single command with redirections", () => {
  assert.deepEqual(parsePipeline("  samtools view -h in.bam >out.sam 2>> log.txt "), [
    { program: "samtools", args: ["view", "-h", "in.bam"], redirects: { stdout: { path: "out.sam", append: false }, stderr: { path: "log.txt", append: true } } },
  ]);
});

test("splits a pipeline into stages", () => {
  const stages = parsePipeline("minimap2 -a ref.fa reads.fq 2> map.log | samtools sort -o out.bam - | samtools index out.bam");
  assert.deepEqual(stages.map(stage => [stage.program, stage.args]), [
    ["minimap2", ["-a", "ref.fa", "reads.fq"]],
    ["samtools", ["sort", "-o", "out.bam", "-"]],
    ["samtools", ["index", "out.bam"]],
  ]);
  assert.deepEqual(stages[0].redirects, { stderr: { path: "map.log", append: false } });
});

test("accepts < on the first stage and > on the last", () => {
  const stages = parsePipeline("seqtk seq <reads.fq | samtools view -b - > out.bam");
  assert.equal(stages[0].redirects.stdin, "reads.fq");
  assert.deepEqual(stages[1].redirects.stdout, { path: "out.bam", append: false });
});

test("rejects misplaced redirections", () => {
  assert.throws(() => parsePipeline("samtools view a.bam | samtools sort < b.bam"), /first command/);
  assert.throws(() => parsePipeline("samtools view a.bam > x.sam | samtools sort"), /last command/);
});

test("rejects empty stages and unspaced or unsupported operators", () => {
  for (const command of ["", "| samtools view", "samtools view |", "samtools view | | samtools sort"]) {
    assert.throws(() => parsePipeline(command), /Expecting a command/, command);
  }
  assert.throws(() => parsePipeline("samtools view a.bam|samtools sort"), /spaces around/);
  assert.throws(() => parsePipeline("samtools view a || samtools view b"), /spaces around|not supported/);
  assert.throws(() => parsePipeline("samtools view a && samtools view b"), /not supported/);
  assert.throws(() => parsePipeline("samtools view a 2>&1"), /not supported/);
  assert.throws(() => parsePipeline("samtools view >"), /file name/);
  assert.throws(() => parsePipeline("> out.sam"), /program name/);
});

test("splits a command on && into pipelines", () => {
  const pipelines = parseCommand("minimap2 -a ref.fa reads.fq | samtools sort -o out.bam - && samtools index out.bam");
  assert.deepEqual(pipelines.map(stages => stages.map(stage => [stage.program, ...stage.args])), [
    [["minimap2", "-a", "ref.fa", "reads.fq"], ["samtools", "sort", "-o", "out.bam", "-"]],
    [["samtools", "index", "out.bam"]],
  ]);
  assert.throws(() => parseCommand("samtools view a > x.sam && samtools view x.sam | samtools sort < y"), /first command/);
});

test("rejects empty or unspaced && sides", () => {
  for (const command of ["&& samtools index a.bam", "samtools index a.bam &&", "samtools index a && && samtools index b"]) {
    assert.throws(() => parseCommand(command), /Expecting a command/, command);
  }
  assert.throws(() => parseCommand("samtools index a.bam&&samtools index b.bam"), /spaces around/);
  assert.throws(() => parseCommand("samtools view a | && samtools view b"), /Expecting a command/);
});
