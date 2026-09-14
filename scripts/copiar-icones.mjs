#!/usr/bin/env node
/**
 * Copia os ícones para dist/, preservando a estrutura de diretórios.
 * O tsc só emite .js — os .svg referenciados em `icon: 'file:...'` precisam
 * acompanhar. Evita a dependência do gulp, que é o caminho convencional.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origens = ['nodes', 'credentials'];
const extensoes = ['.svg', '.png'];

let copiados = 0;

function varrer(dir) {
	if (!existsSync(dir)) return;
	for (const entrada of readdirSync(dir)) {
		const caminho = join(dir, entrada);
		if (statSync(caminho).isDirectory()) {
			varrer(caminho);
		} else if (extensoes.some((ext) => entrada.endsWith(ext))) {
			const destino = join(raiz, 'dist', relative(raiz, caminho));
			mkdirSync(dirname(destino), { recursive: true });
			cpSync(caminho, destino);
			copiados++;
		}
	}
}

for (const origem of origens) varrer(join(raiz, origem));

console.log(`${copiados} ícone(s) copiado(s) para dist/`);
