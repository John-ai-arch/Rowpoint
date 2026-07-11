// Cross-platform e2e web server launcher (used by playwright.config.js).
// Replaces the previous Linux-only shell one-liner: wipes the throwaway
// data directory and starts the server with the e2e port/env on any OS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), 'rowpoint-e2e');
fs.rmSync(dataDir, { recursive: true, force: true });
process.env.ROWPOINT_DATA_DIR = dataDir;
process.env.PORT = process.env.PORT || '4381';
process.env.ROWPOINT_BACKUPS_ENABLED = '0';

const { startServer } = await import('../../server/index.js');
await startServer();
