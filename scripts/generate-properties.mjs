#!/usr/bin/env node
/**
 * Generates nodes/AcbrApi/properties.generated.ts from de-para/*.json.
 *
 * The node properties are not hand-written. The source of truth is the de-para
 * mapping, which a tax specialist can review without reading TypeScript, and
 * which is reused when extending to the other Brazilian fiscal documents and to
 * other automation platforms.
 *
 * It emits three things:
 *   1. the INodeProperties of each resource;
 *   2. the path maps — n8n parameter name to JSON path in the payload — so the
 *      request body is assembled from data instead of field-by-field code;
 *   3. ERROR_MAP — the API's Portuguese messages mapped to English text plus
 *      how each one is handled.
 *
 * Usage: node scripts/generate-properties.mjs   (npm run gen)
 *
 * Keys read from the de-para JSON keep their original Portuguese names, because
 * they are the mapping's own schema: campos, secoes, valores, erros, and the
 * per-field keys. Renaming them here would silently stop reading the file.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, 'nodes/AcbrApi/properties.generated.ts');

const readJson = (rel) => JSON.parse(readFileSync(resolve(root, rel), 'utf8'));

const nfse = readJson('de-para/nfse-dps.json');
const company = readJson('de-para/empresa.json');

const warnings = [];

/**
 * Tells whether a field is filled in by the node or read from the credential,
 * in which case it is never rendered in the UI.
 *
 * @param field One entry of the de-para mapping.
 */
const isHidden = (field) =>
	field.section === 'auto' || field.fill === 'node' || field.fill === 'credential';

const TYPES = {
	string: 'string',
	number: 'number',
	boolean: 'boolean',
	options: 'options',
	dateTime: 'dateTime',
	resourceLocator: 'string',
};

const DEFAULT_BY_TYPE = { string: '', number: 0, boolean: false, dateTime: '' };

/**
 * Resolves the default value a property must carry.
 *
 * INodeProperties always requires a default. When the de-para does not state
 * one it is derived from the type, and for options it is the first value.
 *
 * @param field One entry of the de-para mapping.
 * @param type The already mapped n8n type.
 * @param options The options list, when the type is 'options'.
 */
function resolveDefault(field, type, options) {
	if (field.default !== undefined) return field.default;
	if (type === 'options') return options?.[0]?.value ?? '';
	return DEFAULT_BY_TYPE[type] ?? '';
}

/**
 * Maps a de-para type to an n8n property type.
 *
 * @param field One entry of the de-para mapping.
 * @param key The field's JSON path, used in the warning message.
 * @returns The n8n type, or null when the field cannot be generated yet.
 */
function mapType(field, key) {
	if (field.type === 'fixedCollection') {
		warnings.push(`skipped (fixedCollection not supported yet): ${key}`);
		return null;
	}
	const type = TYPES[field.type];
	if (!type) {
		warnings.push(`skipped (unknown type "${field.type}"): ${key}`);
		return null;
	}
	return type;
}

/**
 * Builds the description shown under the parameter.
 *
 * The original API field name is appended so the user can cross-reference the
 * ACBr documentation and the API's error messages, which are in Portuguese and
 * name the field.
 *
 * @param field One entry of the de-para mapping.
 */
function buildDescription(field) {
	const parts = [field.description];
	if (field.ptName) parts.push(`API field: ${field.ptName}.`);
	if (field.optionsPendentes) parts.push('Some values for this field are not yet documented.');
	return parts.filter(Boolean).join(' ');
}

/**
 * Builds the options list of an enum property.
 *
 * @param field One entry of the de-para mapping.
 * @returns The options, or null when the field declares none.
 */
function buildOptions(field) {
	const values = field.options ?? field.valores;
	if (!Array.isArray(values)) return null;
	return values
		.filter((o) => o.value !== undefined)
		.map((o) => ({ name: o.label ?? String(o.value), value: o.value }));
}

/**
 * Builds a single INodeProperties entry.
 *
 * @param key The field's JSON path in the API payload.
 * @param field One entry of the de-para mapping.
 * @param displayWhen displayOptions.show condition, when the property is flat.
 * @returns The property and its path, or null when it cannot be generated.
 */
function buildProperty(key, field, displayWhen) {
	const type = mapType(field, key);
	if (!type) return null;

	const options = type === 'options' ? buildOptions(field) : null;
	if (type === 'options' && (!options || options.length === 0)) {
		warnings.push(`skipped (empty options — values still undocumented): ${key}`);
		return null;
	}

	const prop = {
		displayName: field.displayName,
		name: field.name,
		type,
		default: resolveDefault(field, type, options),
		description: buildDescription(field),
	};

	if (field.required) prop.required = true;
	if (options) prop.options = options;
	if (field.n8n?.typeOptions) prop.typeOptions = field.n8n.typeOptions;
	if (displayWhen) prop.displayOptions = { show: displayWhen };

	return { prop, key, path: key };
}

/**
 * Generates every property of one resource, plus its parameter-to-path map.
 *
 * Sections marked with a toggle become a collection ("Additional Fields")
 * instead of loose parameters, which is the n8n pattern for progressive
 * disclosure.
 *
 * @param fields The de-para `campos` object of the resource.
 * @param sections The de-para `secoes` object, when the resource has sections.
 * @param displayWhen displayOptions.show condition applied to the properties.
 * @param collectionPrefix Prefix of the generated collection parameter names.
 * @returns The properties and the parameter name to JSON path map.
 */
function generateResource({ fields, sections, displayWhen, collectionPrefix }) {
	const flat = [];
	const collections = new Map();
	const paths = {};

	for (const [key, field] of Object.entries(fields)) {
		if (isHidden(field)) continue;

		const section = sections?.[field.section];
		const behindToggle = Boolean(section?.toggle);
		const generated = buildProperty(key, field, behindToggle ? undefined : displayWhen);
		if (!generated) continue;

		paths[field.name] = key;

		if (behindToggle) {
			const collectionName = `${collectionPrefix}${field.section.charAt(0).toUpperCase()}${field.section.slice(1)}`;
			if (!collections.has(collectionName)) {
				collections.set(collectionName, {
					displayName: section.displayName,
					name: collectionName,
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					displayOptions: displayWhen ? { show: displayWhen } : undefined,
					options: [],
				});
			}
			collections.get(collectionName).options.push(generated.prop);
		} else {
			flat.push(generated.prop);
		}
	}

	return { props: [...flat, ...collections.values()], paths };
}

const nfseGenerated = generateResource({
	fields: nfse.campos,
	sections: nfse.secoes,
	displayWhen: { resource: ['nfse'], operation: ['create', 'preview'] },
	collectionPrefix: 'nfse',
});

// The cancellation body is a second payload of the same tag, generated by the
// same function — which is the proof that it generalizes beyond issuing.
const cancelGenerated = generateResource({
	fields: nfse.cancelamento.campos,
	sections: nfse.secoes,
	displayWhen: { resource: ['nfse'], operation: ['cancel'] },
	collectionPrefix: 'nfse',
});

const companyGenerated = generateResource({
	fields: {
		...company.cadastro.campos,
		...company.certificado.campos,
		...company.configuracaoNfse.campos,
	},
	sections: undefined,
	displayWhen: { resource: ['empresa'] },
	collectionPrefix: 'empresa',
});

const errors = Object.fromEntries(
	Object.entries(nfse.erros)
		.filter(([key]) => key !== 'nota')
		.map(([key, e]) => [
			key,
			{
				httpStatus: e.httpStatus ?? null,
				apiCode: e.apiCode ?? null,
				apiMessagePt: e.apiMessagePt ?? null,
				displayMessage: e.displayMessage,
				tratamento: e.tratamento,
			},
		]),
);

const header = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: de-para/nfse-dps.json, de-para/empresa.json
 * Generator: scripts/generate-properties.mjs  (npm run gen)
 *
 * To change a label, a description or an enum, edit the de-para mapping and run
 * \`npm run gen\`. Editing this file is lost on the next generation.
 */

import type { INodeProperties } from 'n8n-workflow';
`;

const body = `
export const nfseFields: INodeProperties[] = ${JSON.stringify(nfseGenerated.props, null, '\t')};

export const nfseCancelFields: INodeProperties[] = ${JSON.stringify(
	cancelGenerated.props,
	null,
	'\t',
)};

export const empresaFields: INodeProperties[] = ${JSON.stringify(
	companyGenerated.props,
	null,
	'\t',
)};

/**
 * n8n parameter name to JSON path in the API payload.
 *
 * This is what allows the request body to be assembled from data instead of
 * field-by-field code. Kept per resource on purpose: a single map would make
 * invoice issuing walk the company fields too, and some names collide between
 * the two.
 */
export const NFSE_PATHS: Record<string, string> = ${JSON.stringify(nfseGenerated.paths, null, '\t')};

/** Parameter name to field in the body of POST /nfse/{id}/cancelamento. */
export const NFSE_CANCEL_PATHS: Record<string, string> = ${JSON.stringify(
	cancelGenerated.paths,
	null,
	'\t',
)};

export const EMPRESA_PATHS: Record<string, string> = ${JSON.stringify(
	companyGenerated.paths,
	null,
	'\t',
)};

/**
 * The API's Portuguese messages mapped to the English text shown to the user,
 * plus how each case is handled. \`replayIdempotente\` must not be propagated as
 * a failure: it returns the invoice that was already issued.
 */
export const ERROR_MAP = ${JSON.stringify(errors, null, '\t')} as const;
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, header + body, 'utf8');

const count = (o) => Object.keys(o).length;
console.log('properties.generated.ts written');
console.log(`  NFS-e:   ${nfseGenerated.props.length} properties`);
console.log(`  Cancel:  ${cancelGenerated.props.length} properties`);
console.log(`  Company: ${companyGenerated.props.length} properties`);
console.log(
	`  Paths:   ${count(nfseGenerated.paths) + count(cancelGenerated.paths) + count(companyGenerated.paths)}`,
);
console.log(`  Errors:  ${count(errors)}`);

if (warnings.length) {
	console.log(`\n${warnings.length} field(s) not generated:`);
	for (const w of warnings) console.log(`  - ${w}`);
}
