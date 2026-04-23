#!/usr/bin/env node
import path from 'node:path';
import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { cli } from './cli.js';

function findEnvFile(start: string): string | undefined {
  let dir = start;
  while (true) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const envPath = findEnvFile(process.cwd());
if (envPath) loadDotenv({ path: envPath });

cli.run(process.argv);
