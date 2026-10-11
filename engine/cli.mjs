// Runs the engine on a parsed-document JSON file: node engine/cli.mjs <parsed.json> [A|AA]
import { readFile } from 'node:fs/promises';
import { analyze } from './index.mjs';
const [file, level = 'AA'] = process.argv.slice(2);
if (!file) { console.error('Usage: node engine/cli.mjs <parsed.json> [A|AA]'); process.exit(2); }
try {
  console.log(JSON.stringify(analyze(JSON.parse(await readFile(file,'utf8')),{wcagLevel:level}),null,2));
} catch (e) {
  console.log(JSON.stringify({error:{code:e.code || 'INVALID_PARSED_DOCUMENT',message:e.message}},null,2));
  process.exit(1);
}
