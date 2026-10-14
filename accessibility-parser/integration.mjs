// Place in the repository root, alongside engine/. Run from that directory.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyze } from './engine/index.mjs';
const execFileAsync = promisify(execFile);

/** Analyze an already-validated temporary upload path; delete it in the API finally block. */
export async function analyzeUploadedDocument(uploadPath, wcagLevel = 'AA') {
  const { stdout } = await execFileAsync('python3', ['-m', 'parser.cli', uploadPath], {
    timeout: 25000, maxBuffer: 16 * 1024 * 1024
  }).catch(error => {
    // Parser reports a structured error on stdout even when it exits nonzero.
    if (error.stdout) return { stdout: error.stdout };
    throw error;
  });
  const parsed = JSON.parse(stdout);
  if (parsed.error) {
    const error = new Error(parsed.error.message);
    error.code = parsed.error.code;
    throw error;
  }
  return analyze(parsed, { wcagLevel });
}
