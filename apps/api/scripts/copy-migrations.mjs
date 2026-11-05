import { cpSync } from 'node:fs';
cpSync('src/migrations', 'dist/migrations', { recursive: true });
