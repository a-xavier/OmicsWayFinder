/**
 * The command syntax of every backend, a small subset of a shell's: pipelines joined by ` && `,
 * stages joined by ` | `, and the redirections `<`, `>`, `>>`, `2>` and `2>>`. Words are split on
 * whitespace (no quoting, variables or globs). Each backend decides which parts it runs (the
 * Java backend has no pipes yet).
 */

/** Send a stream to a folder file instead of the result, like `> file` (append: `>> file`). */
export type Redirect = { path: string; append: boolean };
/** `stdin`: read a folder file, like `< file`. */
export type Redirects = { stdin?: string; stdout?: Redirect; stderr?: Redirect };

/** One program of a pipeline: `a | b` has two stages, connected stdout to stdin. */
export type Stage = { program: string; args: string[]; redirects: Redirects };

// Shell operators a single pipeline cannot contain; rejected rather than passed to the tool as
// arguments. "&&" is supported, but parseCommand splits on it before parsePipeline runs, so it
// only reaches this check when parsePipeline is called directly.
const UNSUPPORTED_OPERATORS = new Set(["||", "&&", "&", ";"]);

/**
 * Split a command string into pipelines joined by ` && ` (each runs only if the previous one
 * succeeded), each parsed by parsePipeline.
 */
export function parseCommand(command: string): Stage[][] {
  return splitOn(command, "&&", "").map(group => parsePipeline(group.join(" ")));
}

/**
 * Split a command string into pipeline stages on ` | ` and each stage on whitespace (no quoting
 * or globs), taking out redirections: `< file` (first stage only), `> file` and `>> file` (last
 * stage only), `2> file` and `2>> file` (any stage); also written without the space, as `>file`.
 */
export function parsePipeline(command: string): Stage[] {
  const groups = splitOn(command, "|", '; "||" is not supported');
  return groups.map((group, index) => {
    const stage = parseStage(group);
    const last = index === groups.length - 1;
    if (index > 0 && stage.redirects.stdin !== undefined) {
      throw new Error(`"<" can only be used in the first command of a pipeline (${stage.program} reads the pipe).`);
    }
    if (!last && stage.redirects.stdout) {
      throw new Error(`">" can only be used in the last command of a pipeline (${stage.program} writes to the pipe).`);
    }
    return stage;
  });
}

/**
 * Split a command into words, and the words into groups on `operator` (a word of its own).
 * `hint` is added to the error for an operator written without spaces.
 */
function splitOn(command: string, operator: string, hint: string): string[][] {
  const words = command.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error("Expecting a command.");
  const groups: string[][] = [[]];
  for (const word of words) {
    if (word === operator) groups.push([]);
    else if (word.includes(operator)) throw new Error(`Put spaces around "${operator}" (in "${word}")${hint}.`);
    else groups[groups.length - 1].push(word);
  }
  groups.forEach((group, index) => {
    if (group.length === 0) throw new Error(`Expecting a command ${index === 0 ? "before" : "after"} "${operator}".`);
  });
  return groups;
}

function parseStage(words: string[]): Stage {
  const args: string[] = [];
  const redirects: Redirects = {};
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (UNSUPPORTED_OPERATORS.has(word)) throw new Error(`The shell operator "${word}" is not supported.`);
    const match = /^([12]?)(>>?)(.*)$/.exec(word) ?? /^()(<)(.*)$/.exec(word);
    if (!match) {
      args.push(word);
      continue;
    }
    const [, fd, operator, attached] = match;
    if (attached.startsWith("&") || attached.startsWith("<") || attached.startsWith(">")) {
      throw new Error(`"${word}" is not supported.`);
    }
    const path = attached || words[++i];
    if (!path || /^[<>&;]/.test(path)) throw new Error(`Expecting a file name after "${fd}${operator}".`);
    if (operator === "<") redirects.stdin = path;
    else redirects[fd === "2" ? "stderr" : "stdout"] = { path, append: operator === ">>" };
  }
  const [program = "", ...rest] = args;
  if (!program) throw new Error("Expecting a program name before the redirections.");
  return { program, args: rest, redirects };
}
