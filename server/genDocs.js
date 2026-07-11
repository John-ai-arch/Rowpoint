// Documentation generator CLI — `npm run docs`.
//
// Brings the full platform up (every engine registers its components) and
// writes the generated documentation set to docs/generated/. Run it after
// any structural change; the output is read from live registries and the
// actual schema, so it cannot drift from the implementation.
import { initEngines } from './index.js';
import { generateDocs } from './rpos/index.js';

initEngines();
const files = generateDocs();
console.log(`Generated ${files.length} documents:`);
for (const f of files) console.log(`  ${f}`);
