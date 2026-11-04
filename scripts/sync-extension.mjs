import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'path-tracer.js');
const target = path.join(root, 'extension', 'path-tracer.js');

fs.copyFileSync(source, target);
console.log('extension/path-tracer.js <- path-tracer.js');
