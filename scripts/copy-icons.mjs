#!/usr/bin/env node
/**
 * Copies the node and credential icons into dist/, preserving the directory
 * structure.
 *
 * tsc only emits .js, so the .svg files referenced by `icon: 'file:...'` have
 * to be carried over separately. Doing it here avoids the gulp dependency that
 * the conventional n8n scaffold pulls in.
 *
 * Usage: node scripts/copy-icons.mjs   (runs as part of npm run build)
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = ['nodes', 'credentials'];
const extensions = ['.svg', '.png'];

let copied = 0;

/**
 * Walks a directory recursively, copying every icon it finds into dist/.
 *
 * @param dir Absolute path of the directory to scan.
 */
function walk(dir) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			walk(path);
		} else if (extensions.some((ext) => entry.endsWith(ext))) {
			const target = join(root, 'dist', relative(root, path));
			mkdirSync(dirname(target), { recursive: true });
			cpSync(path, target);
			copied++;
		}
	}
}

for (const source of sources) walk(join(root, source));

console.log(`${copied} icon(s) copied to dist/`);
