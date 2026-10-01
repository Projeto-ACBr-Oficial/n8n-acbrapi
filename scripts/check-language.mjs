#!/usr/bin/env node
/**
 * Fails the build when Portuguese reappears in the package.
 *
 * n8n verification requires English everywhere a developer or a user can read,
 * including inline comments. This was caught by a human reviewer once, after
 * the package was already published twice; nothing in the pipeline was checking
 * for it. This script is that check.
 *
 * It is a heuristic, not a language classifier: it flags Portuguese diacritics
 * and a short list of words that do not exist in English. That catches the real
 * case — someone writes a comment in Portuguese — without pretending to be
 * exhaustive.
 *
 * Legitimate Portuguese is allowed through ALLOWED below, each entry with the
 * reason it has to stay. Add to it only for text that is data, never for prose.
 *
 * Usage: node scripts/check-language.mjs   (npm run lint:language)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files and directories to scan. Directories are walked recursively. */
const TARGETS = [
	'nodes',
	'credentials',
	'scripts',
	'de-para',
	'.github/workflows',
	'tsconfig.json',
	'eslint.config.mjs',
	'docker-compose.yml',
	'.env.example',
	'README.md',
	'package.json',
];

const EXTENSIONS = ['.ts', '.mjs', '.js', '.json', '.yml', '.yaml', '.md', '.example'];

const SKIP = [
	// Generated from de-para/, which is checked at its source.
	'nodes/AcbrApi/properties.generated.ts',
	// This file: its own patterns are Portuguese by definition.
	'scripts/check-language.mjs',
];

const DIACRITICS = /[ãõáéíóúâêôàçÃÕÁÉÍÓÚÂÊÔÀÇ]/;

/** Words with no English homograph, so they do not produce false positives. */
const WORDS =
	/\b(nao|porque|quando|entao|tambem|apenas|mesmo|cada|sobre|pelo|pela|isso|essa|esse|nunca|sempre|aqui|ainda|sendo|fica|vira|deve|pode|seja|caso|dele|dela)\b/i;

/**
 * Portuguese that has to stay, with the reason. Matched as a substring on the
 * offending line.
 */
const ALLOWED = [
	// The API's own error strings, matched literally against its responses.
	// Translating them breaks error detection, including the duplicate-reference
	// replay that prevents issuing a second invoice.
	"O campo 'referencia' deve ser único",
	'X999: Erro de Conexão: Não informado a URL de Homologação',
	"O campo 'InfDPS.Valores.Trib.TotTrib' é obrigatório",
	// ptName carries the field's real name in the API and in the console. It is
	// what lets a user cross-reference an API error back to a parameter.
	'"ptName"',
	// Portuguese values that are part of the API contract.
	'homologacao',
	'producao',
	'nacional',
	// Our own term for the mapping files.
	'de-para',
];

/**
 * Lists every file to scan, walking directories.
 *
 * @param target Path relative to the package root.
 */
function collect(target) {
	const full = resolve(root, target);
	let stats;
	try {
		stats = statSync(full);
	} catch {
		return [];
	}
	if (stats.isFile()) return [full];
	return readdirSync(full).flatMap((entry) => collect(join(target, entry)));
}

const offences = [];

for (const file of TARGETS.flatMap(collect)) {
	const rel = relative(root, file).replace(/\\/g, '/');
	if (SKIP.includes(rel)) continue;
	if (!EXTENSIONS.some((ext) => rel.endsWith(ext))) continue;

	const lines = readFileSync(file, 'utf8').split('\n');
	lines.forEach((line, index) => {
		if (!DIACRITICS.test(line) && !WORDS.test(line)) return;
		if (ALLOWED.some((allowed) => line.includes(allowed))) return;
		offences.push({ rel, line: index + 1, text: line.trim() });
	});
}

if (offences.length === 0) {
	console.log('language check: no Portuguese found outside the allowed list');
	process.exit(0);
}

console.error(`language check failed: ${offences.length} line(s) look like Portuguese\n`);
for (const o of offences) {
	console.error(`  ${o.rel}:${o.line}`);
	console.error(`    ${o.text.slice(0, 120)}`);
}
console.error(
	'\nn8n verification requires English everywhere, inline comments included.\n' +
		'If a line is legitimately Portuguese — an API string matched literally, a\n' +
		'real field name — add it to ALLOWED in scripts/check-language.mjs with the\n' +
		'reason it has to stay.',
);
process.exit(1);
