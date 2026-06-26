import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

await mkdir(dist, { recursive: true });
await copyFile(resolve(dist, 'worker.js'), resolve(dist, '_worker.js'));
await writeFile(
  resolve(dist, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>Vertex API Worker</title><pre>Vertex API Worker is running. Use /health or /v1.</pre>\n'
);

console.log('Prepared Cloudflare Pages output in dist/.');
