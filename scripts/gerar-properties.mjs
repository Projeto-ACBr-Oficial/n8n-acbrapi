#!/usr/bin/env node
/**
 * Gera nodes/AcbrApi/properties.generated.ts a partir de de-para/*.json.
 *
 * As properties do node NÃO são escritas à mão. A fonte de verdade é o de-para,
 * que um fiscalista revisa sem ler TypeScript, e que se reaproveita ao estender
 * para os outros DF-e e para outras plataformas de automação.
 *
 * Emite três coisas:
 *   1. as INodeProperties por recurso;
 *   2. FIELD_PATHS — nome do parâmetro no n8n → caminho JSON no payload, para
 *      a montagem ser orientada a dados em vez de codificada à mão;
 *   3. ERROR_MAP — mensagens da API em pt-BR → texto em inglês + tratamento.
 *
 * Uso: node scripts/gerar-properties.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destino = resolve(raiz, 'nodes/AcbrApi/properties.generated.ts');

const ler = (rel) => JSON.parse(readFileSync(resolve(raiz, rel), 'utf8'));

const nfse = ler('de-para/nfse-dps.json');
const empresa = ler('de-para/empresa.json');

const avisos = [];

/** Campos que o node preenche sozinho ou lê da credencial nunca são renderizados. */
const naoRenderizar = (campo) =>
	campo.section === 'auto' || campo.fill === 'node' || campo.fill === 'credential';

const TIPOS = {
	string: 'string',
	number: 'number',
	boolean: 'boolean',
	options: 'options',
	dateTime: 'dateTime',
	// No scaffold o resourceLocator vira string. Volta a ser resourceLocator com
	// busca quando a tabela cTribNac existir (P-01).
	resourceLocator: 'string',
};

/**
 * INodeProperties exige `default` sempre. Quando o de-para não informa, deriva
 * do tipo — para `options`, o primeiro valor da lista.
 */
const DEFAULT_POR_TIPO = { string: '', number: 0, boolean: false, dateTime: '' };

function resolverDefault(campo, tipo, options) {
	if (campo.default !== undefined) return campo.default;
	if (tipo === 'options') return options?.[0]?.value ?? '';
	return DEFAULT_POR_TIPO[tipo] ?? '';
}

function mapearTipo(campo, chave) {
	if (campo.type === 'fixedCollection') {
		avisos.push(`ignorado (fixedCollection ainda não suportada): ${chave}`);
		return null;
	}
	const tipo = TIPOS[campo.type];
	if (!tipo) {
		avisos.push(`ignorado (tipo desconhecido "${campo.type}"): ${chave}`);
		return null;
	}
	return tipo;
}

function montarDescription(campo) {
	const partes = [campo.description];
	// O caminho original vai na descrição para o usuário conseguir cruzar com a
	// documentação da ACBr e com a mensagem de erro da API, que vem em pt-BR
	// citando o nome do campo (P-17).
	if (campo.ptName) partes.push(`API field: ${campo.ptName}.`);
	if (campo.optionsPendentes) partes.push('Some values for this field are not yet documented.');
	return partes.filter(Boolean).join(' ');
}

function montarOptions(campo) {
	const valores = campo.options ?? campo.valores;
	if (!Array.isArray(valores)) return null;
	return valores
		.filter((o) => o.value !== undefined)
		.map((o) => ({ name: o.label ?? String(o.value), value: o.value }));
}

function propriedade(chave, campo, exibirQuando) {
	const tipo = mapearTipo(campo, chave);
	if (!tipo) return null;

	const options = tipo === 'options' ? montarOptions(campo) : null;
	if (tipo === 'options' && (!options || options.length === 0)) {
		avisos.push(`ignorado (options vazio — valores pendentes): ${chave}`);
		return null;
	}

	const prop = {
		displayName: campo.displayName,
		name: campo.name,
		type: tipo,
		default: resolverDefault(campo, tipo, options),
		description: montarDescription(campo),
	};

	if (campo.required) prop.required = true;
	if (options) prop.options = options;
	if (campo.n8n?.typeOptions) prop.typeOptions = campo.n8n.typeOptions;
	if (exibirQuando) prop.displayOptions = { show: exibirQuando };

	return { prop, chave, path: chave };
}

/**
 * Seções com toggle viram uma collection ("Additional Fields") em vez de campos
 * soltos, que é o padrão do n8n para revelação progressiva.
 */
function gerarRecurso({ campos, secoes, exibirQuando, prefixoCollection }) {
	const planas = [];
	const collections = new Map();
	const paths = {};

    for (const [chave, campo] of Object.entries(campos)) {
		if (naoRenderizar(campo)) continue;

		const secao = secoes?.[campo.section];
		const comToggle = Boolean(secao?.toggle);
		const gerada = propriedade(chave, campo, comToggle ? undefined : exibirQuando);
		if (!gerada) continue;

		paths[campo.name] = chave;

		if (comToggle) {
			const nomeCollection = `${prefixoCollection}${campo.section.charAt(0).toUpperCase()}${campo.section.slice(1)}`;
			if (!collections.has(nomeCollection)) {
				collections.set(nomeCollection, {
					displayName: secao.displayName,
					name: nomeCollection,
					type: 'collection',
					placeholder: 'Add Field',
					default: {},
					displayOptions: exibirQuando ? { show: exibirQuando } : undefined,
					options: [],
				});
			}
			collections.get(nomeCollection).options.push(gerada.prop);
		} else {
			planas.push(gerada.prop);
		}
	}

	return { props: [...planas, ...collections.values()], paths };
}

const nfseGerado = gerarRecurso({
	campos: nfse.campos,
	secoes: nfse.secoes,
	exibirQuando: { resource: ['nfse'], operation: ['create', 'preview'] },
	prefixoCollection: 'nfse',
});

// Segundo payload da mesma tag: corpo do cancelamento. Passa pelo mesmo gerador,
// o que é o teste de que ele generaliza além da emissão.
const cancelGerado = gerarRecurso({
	campos: nfse.cancelamento.campos,
	secoes: nfse.secoes,
	exibirQuando: { resource: ['nfse'], operation: ['cancel'] },
	prefixoCollection: 'nfse',
});

const empresaCampos = {
	...empresa.cadastro.campos,
	...empresa.certificado.campos,
	...empresa.configuracaoNfse.campos,
};
const empresaGerado = gerarRecurso({
	campos: empresaCampos,
	secoes: undefined,
	exibirQuando: { resource: ['empresa'] },
	prefixoCollection: 'empresa',
});

const erros = Object.fromEntries(
	Object.entries(nfse.erros)
		.filter(([chave]) => chave !== 'nota')
		.map(([chave, e]) => [
			chave,
			{
				httpStatus: e.httpStatus ?? null,
				apiCode: e.apiCode ?? null,
				apiMessagePt: e.apiMessagePt ?? null,
				displayMessage: e.displayMessage,
				tratamento: e.tratamento,
			},
		]),
);

const cabecalho = `/**
 * ARQUIVO GERADO — NÃO EDITAR.
 *
 * Fonte: de-para/nfse-dps.json, de-para/empresa.json
 * Gerador: scripts/gerar-properties.mjs  (npm run gen)
 *
 * Para mudar um rótulo, uma descrição ou um enum, edite o de-para e rode
 * \`npm run gen\`. Editar aqui é perdido na próxima geração.
 */

import type { INodeProperties } from 'n8n-workflow';
`;

const corpo = `
export const nfseFields: INodeProperties[] = ${JSON.stringify(nfseGerado.props, null, '\t')};

export const nfseCancelFields: INodeProperties[] = ${JSON.stringify(
	cancelGerado.props,
	null,
	'\t',
)};

export const empresaFields: INodeProperties[] = ${JSON.stringify(empresaGerado.props, null, '\t')};

/**
 * Nome do parâmetro no n8n → caminho no payload da API.
 * Permite montar o corpo da requisição por dados, sem código por campo.
 *
 * Separado por recurso de propósito: um mapa único faria a emissão de NFS-e
 * varrer também os campos de Empresa, e há nomes que colidem entre os dois.
 */
export const NFSE_PATHS: Record<string, string> = ${JSON.stringify(nfseGerado.paths, null, '\t')};

/** Nome do parâmetro → campo no corpo de POST /nfse/{id}/cancelamento. */
export const NFSE_CANCEL_PATHS: Record<string, string> = ${JSON.stringify(
	cancelGerado.paths,
	null,
	'\t',
)};

export const EMPRESA_PATHS: Record<string, string> = ${JSON.stringify(
	empresaGerado.paths,
	null,
	'\t',
)};

/**
 * Mensagens da API (pt-BR) → texto exibido ao usuário (inglês) + tratamento.
 * \`replayIdempotente\` NÃO deve ser propagado como falha — devolve a nota já emitida.
 */
export const ERROR_MAP = ${JSON.stringify(erros, null, '\t')} as const;
`;

mkdirSync(dirname(destino), { recursive: true });
writeFileSync(destino, cabecalho + corpo, 'utf8');

const contar = (o) => Object.keys(o).length;
console.log('properties.generated.ts gerado');
console.log(`  NFS-e:   ${nfseGerado.props.length} properties`);
console.log(`  Cancel:  ${cancelGerado.props.length} properties`);
console.log(`  Empresa: ${empresaGerado.props.length} properties`);
console.log(
	`  Paths:   ${contar(nfseGerado.paths) + contar(cancelGerado.paths) + contar(empresaGerado.paths)}`,
);
console.log(`  Erros:   ${contar(erros)}`);

if (avisos.length) {
	console.log(`\n${avisos.length} campo(s) não gerado(s) — esperado enquanto P-06 estiver aberto:`);
	for (const a of avisos) console.log(`  - ${a}`);
}
