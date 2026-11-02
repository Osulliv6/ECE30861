// Node bridge to the Python parser. The server passes the validated upload bytes;
// this writes them to a private temp directory, runs `python -m parser.cli`, and
// always deletes the directory afterwards (including any repaired copy).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const parserDir = dirname(fileURLToPath(import.meta.url));
// PYTHON overrides; otherwise prefer the parser's local virtualenv (see README), then python3 on PATH.
const venvPython = join(parserDir, '.venv', 'bin', 'python');
const defaultPython = process.env.PYTHON || (existsSync(venvPython) ? venvPython : 'python3');

export class ParserError extends Error {
  constructor(message, code, status) { super(message); this.name = 'ParserError'; this.code = code; this.status = status; }
}

function runParser(python, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(python, ['-m', 'parser.cli', ...args], {cwd:parserDir, timeout:timeoutMs, maxBuffer:16 * 1024 * 1024, env:{...process.env, PYTHONDONTWRITEBYTECODE:'1'}}, (error, stdout) => {
      // The CLI prints a structured {"error":...} on stdout and exits 1 for bad documents.
      if (error && !(error.code === 1 && stdout)) return reject(error);
      resolve(stdout);
    });
  });
}

// Runs one CLI command on the upload inside a private temp directory, then deletes it.
// `command(file, dir)` returns the CLI arguments; `finish(parsed, dir)` reads any output files.
async function withUpload(bytes, extension, {python = defaultPython, timeoutMs = 25_000, tmpRoot = tmpdir()}, command, finish = parsed => parsed) {
  const dir = await mkdtemp(join(tmpRoot, 'ada-upload-'));
  try {
    const file = join(dir, `document${extension}`);
    await writeFile(file, bytes, {mode:0o600});
    let stdout;
    try { stdout = await runParser(python.includes('/') ? resolve(python) : python, command(file, dir), timeoutMs); }
    catch (error) {
      if (error.killed) throw new ParserError('Document processing took too long.', 'PROCESSING_TIMEOUT', 503);
      throw new ParserError('The document parser is unavailable.', 'PROCESSING_UNAVAILABLE', 503);
    }
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { throw new ParserError('The document parser returned an unreadable result.', 'PROCESSING_UNAVAILABLE', 503); }
    if (parsed?.error) {
      const status = parsed.error.code === 'UNSUPPORTED_FILE_TYPE' ? 415 : 422;
      throw new ParserError('The file could not be evaluated.', status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'UNPROCESSABLE_FILE', status);
    }
    return await finish(parsed, dir);
  } finally {
    await rm(dir, {recursive:true, force:true});
  }
}

/** Parses an uploaded document. `extension` (e.g. ".docx") selects the parser format. */
export function parseUpload(bytes, extension, options = {}) {
  return withUpload(bytes, extension, options, file => [file]);
}

/**
 * Repairs an uploaded document. Returns {bytes, changes, before, after}: the repaired file,
 * the list of changes, and parser output for the original and repaired documents.
 * `language` and `title` are used only where the document has none (validated by the server).
 */
export function remediateUpload(bytes, extension, {language, title} = {}, options = {}) {
  return withUpload(bytes, extension, options, (file, dir) => {
    // "--flag=value" keeps a value that starts with "-" from being read as an option.
    const args = ['remediate', file, join(dir, `remediated${extension}`)];
    if (language) args.push(`--language=${language}`);
    if (title) args.push(`--title=${title}`);
    return args;
  }, async (parsed, dir) => {
    if (!Array.isArray(parsed?.changes) || !parsed.before || !parsed.after) throw new ParserError('The document parser returned an unreadable result.', 'PROCESSING_UNAVAILABLE', 503);
    return {bytes:await readFile(join(dir, `remediated${extension}`)), changes:parsed.changes, before:parsed.before, after:parsed.after};
  });
}
