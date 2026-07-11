// Generated documentation — from the LIVE platform, never hand-maintained.
//
// Everything documented here is read from running registries (components,
// contracts, events, job kinds), the actual database schema, and light
// static analysis of the route files — so the docs cannot drift from the
// implementation. Regenerate with `npm run docs` (see server/genDocs.js);
// output lands in docs/generated/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { platformInventory } from './plugins.js';

export const DOCS_VERSION = 'rpos.docs@1.0';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* --------------------------- source scanning --------------------------- */

/** First comment block of a module — its self-description. */
function moduleSummary(file) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    const lines = [];
    for (const line of src.split('\n')) {
      const m = line.match(/^\/\/\s?(.*)/);
      if (!m) break;
      if (m[1].trim() === '') break;
      lines.push(m[1].trim());
      if (lines.length >= 2) break;
    }
    return lines.join(' ');
  } catch { return ''; }
}

/** API mounts from server/index.js + per-router routes via static regex. */
function scanRoutes() {
  const indexSrc = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
  const imports = {}; // routerVar → relative file
  for (const m of indexSrc.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
    for (const name of m[1].split(',').map(s => s.trim())) {
      if (name.endsWith('Router')) imports[name] = m[2];
    }
  }
  const mounts = [];
  for (const m of indexSrc.matchAll(/app\.use\('(\/api[^']*)',\s*(\w+)\)/g)) {
    if (imports[m[2]]) mounts.push({ base: m[1], router: m[2], file: imports[m[2]] });
  }
  // Engine entry modules re-export their routers (`export { xRouter } from
  // './api.js'`) — follow the re-export chain to the defining file.
  function definingFile(file, router, depth = 0) {
    if (depth > 3) return null;
    const abs = path.join(SERVER_DIR, file);
    let src = '';
    try { src = fs.readFileSync(abs, 'utf8'); } catch { return null; }
    if (new RegExp(`${router}\\.(get|post|patch|put|delete)\\(`).test(src)) return { file, src };
    for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
      if (m[1].split(',').map(s => s.trim()).includes(router)) {
        const next = path.join(path.dirname(file), m[2]).replace(/\\/g, '/');
        return definingFile(next.startsWith('.') ? next : `./${next}`, router, depth + 1);
      }
    }
    return null;
  }

  const routes = [];
  for (const { base, router, file } of mounts) {
    const found = definingFile(file, router);
    if (!found) continue;
    for (const m of found.src.matchAll(/(\w+Router)\.(get|post|patch|put|delete)\(\s*'([^']*)'/g)) {
      if (m[1] !== router) continue;
      routes.push({ method: m[2].toUpperCase(), path: `${base}${m[3] === '/' ? '' : m[3]}`, source: found.file.replace('./', 'server/') });
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/* ------------------------------ documents ------------------------------ */

function architectureMd() {
  const dirs = fs.readdirSync(SERVER_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && !['node_modules'].includes(e.name)).map(e => e.name).sort();
  let out = '# Architecture map\n\n_Generated from the live codebase — do not edit._\n\n';
  for (const dir of dirs) {
    out += `## server/${dir}/\n\n`;
    const files = fs.readdirSync(path.join(SERVER_DIR, dir)).filter(f => f.endsWith('.js')).sort();
    for (const f of files) {
      out += `- **${f}** — ${moduleSummary(path.join(SERVER_DIR, dir, f)) || '(no module header)'}\n`;
    }
    out += '\n';
  }
  return out;
}

function componentsMd(inv) {
  let out = '# Registered components\n\n_Generated from the kernel version registry._\n\n';
  out += `Totals: ${Object.entries(inv.byKind).map(([k, n]) => `${n} ${k}`).join(' · ')}\n\n`;
  out += '| Component | Kind | Version | Description |\n|---|---|---|---|\n';
  for (const c of inv.components) out += `| ${c.name} | ${c.kind} | ${c.version} | ${c.description || ''} |\n`;
  return out;
}

function eventsMd(inv) {
  let out = '# Event catalog\n\n_Generated from the kernel event bus._\n\n| Event | Subscribers |\n|---|---|\n';
  for (const e of inv.events) out += `| ${e.type} | ${e.subscribers.join(', ') || '—'} |\n`;
  out += '\n# Provider contracts\n\n| Contract | Providers |\n|---|---|\n';
  for (const c of inv.contracts) out += `| ${c.contract} | ${c.providers.join(', ')} |\n`;
  out += '\n# Job kinds\n\n';
  for (const k of inv.jobKinds) out += `- ${k}\n`;
  return out;
}

function schemaMd() {
  const rows = db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name").all();
  let out = '# Database schema\n\n_Generated from sqlite_master._\n\n';
  for (const r of rows.filter(r => r.type === 'table')) out += `## ${r.name}\n\n\`\`\`sql\n${r.sql}\n\`\`\`\n\n`;
  out += '## Indexes & triggers\n\n```sql\n';
  for (const r of rows.filter(r => r.type !== 'table')) out += `${r.sql};\n`;
  out += '```\n';
  return out;
}

function apiMd() {
  const routes = scanRoutes();
  let out = '# API route inventory\n\n_Generated by static scan of the mounted routers._\n\n';
  out += `${routes.length} routes.\n\n| Method | Path | Source |\n|---|---|---|\n`;
  for (const r of routes) out += `| ${r.method} | ${r.path} | ${r.source} |\n`;
  out += '\n## Versioning\n\nEvery engine route is additionally mounted under `/api/v1/...`; '
    + 'the unversioned paths are the v1 aliases and remain stable. Breaking changes ship as `/api/v2/...` mounts.\n';
  return out;
}

/** Write all generated docs. Returns the file list. */
export function generateDocs({ outDir } = {}) {
  const target = outDir || path.join(SERVER_DIR, '..', 'docs', 'generated');
  fs.mkdirSync(target, { recursive: true });
  const inv = platformInventory();
  const stamp = `\n---\n_Generated ${new Date().toISOString()} by ${DOCS_VERSION}._\n`;
  const files = {
    'architecture.md': architectureMd(),
    'components.md': componentsMd(inv),
    'events-jobs-contracts.md': eventsMd(inv),
    'schema.md': schemaMd(),
    'api.md': apiMd(),
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(target, name), content + stamp);
  }
  return Object.keys(files).map(f => path.join(target, f));
}
