// Node bridge to the Python parser. The server passes the validated upload bytes;
// this writes them to a private temp directory, runs `python -m parser.cli`, and
// always deletes the directory afterwards (including any repaired copy).
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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

// Results can be considerably larger than their source documents. Spool them
// privately, with an independent cap so one upload cannot fill the volume.
const MAX_PARSER_OUTPUT_BYTES = 64 * 1024 * 1024;

async function runParser(python, args, resultPath, timeoutMs, maxOutputBytes) {
  const child = spawn(python, ['-m', 'parser.cli', ...args], {
    cwd:parserDir, stdio:['ignore','pipe','ignore'],
    env:{...process.env, PYTHONDONTWRITEBYTECODE:'1'},
  });
  const exited = new Promise(resolve => {
    child.once('error', () => resolve(null));
    child.once('exit', resolve);
  });
  let failure;
  const stop = error => {
    failure ??= error;
    child.kill('SIGKILL');
    child.stdout.destroy(failure);
  };
  const timer = setTimeout(() => stop(
    new ParserError('Document processing took too long.', 'PROCESSING_TIMEOUT', 503)
  ), timeoutMs);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        callback(new ParserError('The analysis result exceeds the service limit. Split the document and try again.', 'UNPROCESSABLE_FILE', 422));
      } else {
        callback(null, chunk);
      }
    },
  });
  try {
    try {
      await pipeline(child.stdout, limit, createWriteStream(resultPath, {mode:0o600}));
    } catch (error) {
      stop(error);
    }
    const code = await exited;
    clearTimeout(timer);
    if (failure instanceof ParserError) throw failure;
    if (failure || (code !== 0 && (code !== 1 || bytes === 0))) {
      throw new ParserError('The document parser is unavailable.', 'PROCESSING_UNAVAILABLE', 503);
    }
    return await readFile(resultPath, 'utf8');
  } finally {
    clearTimeout(timer);
  }
}

// Runs one CLI command on the upload inside a private temp directory, then deletes it.
// `command(file, dir)` returns the CLI arguments; `finish(parsed, dir)` reads any output files.
async function withUpload(bytes, extension, {python = defaultPython, timeoutMs = 25_000, tmpRoot = tmpdir(), maxOutputBytes = MAX_PARSER_OUTPUT_BYTES}, command, finish = parsed => parsed) {
  const dir = await mkdtemp(join(tmpRoot, 'ada-upload-'));
  try {
    const file = join(dir, `document${extension}`);
    await writeFile(file, bytes, {mode:0o600});
    const resultPath = join(dir, 'result.json');
    const stdout = await runParser(python.includes('/') ? resolve(python) : python,
      command(file, dir), resultPath, timeoutMs, maxOutputBytes);
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
