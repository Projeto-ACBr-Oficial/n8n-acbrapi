import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

import {
	ERROR_MAP,
	NFSE_CANCEL_PATHS,
	NFSE_PATHS,
	empresaFields,
	nfseCancelFields,
	nfseFields,
} from './properties.generated';

const BASE_URL: Record<string, string> = {
	producao: 'https://prod.acbr.api.br',
	homologacao: 'https://hom.acbr.api.br',
};

/** Identificação do conector no campo fiscal verAplic. Curto por limite de tamanho (P-33). */
const VER_APLIC = 'n8n-acbrapi/1.0.2';

/** Único status não terminal. Whitelist do que continua, não do que termina. */
const STATUS_EM_ANDAMENTO = 'processando';

const ESCOPO_POR_RECURSO: Record<string, string> = {
	nfse: 'nfse',
	empresa: 'empresa',
	cnpj: 'cnpj',
	cep: 'cep',
	debug: 'debug',
};

function setByPath(alvo: IDataObject, caminho: string, valor: unknown): void {
	if (valor === undefined || valor === null || valor === '') return;
	const partes = caminho.split('.');
	let atual: IDataObject = alvo;
	for (const parte of partes.slice(0, -1)) {
		if (typeof atual[parte] !== 'object' || atual[parte] === null) atual[parte] = {};
		atual = atual[parte] as IDataObject;
	}
	atual[partes[partes.length - 1]] = valor as IDataObject[string];
}

export class AcbrApi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ACBr API',
		name: 'acbrApi',
		icon: 'file:acbrApi.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Issue Brazilian service invoices (NFS-e) and look up companies and addresses',
		defaults: { name: 'ACBr API' },
		// Permite que um AI Agent chame estas operações como ferramentas (P-26).
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'acbrApiOAuth2Api', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'nfse',
				// Ordem alfabética por 'name' e sem o acrônimo hifenizado "NFS-e" nos
				// rótulos: a regra de title case do linter o converte em "NFS-E".
				// O termo correto fica nas descrições, que a regra não altera.
				//
				// Company e Debug estão implementados apenas em parte e ficam FORA
				// do enum no 1.0: a UI não deve prometer operação que lança erro.
				// As properties e o roteamento dos dois continuam abaixo, inertes,
				// e voltam ao enum quando as operações existirem (1.1).
				options: [
					{ name: 'CNPJ', value: 'cnpj' },
					{ name: 'Postal Code', value: 'cep' },
					{
						name: 'Service Invoice',
						value: 'nfse',
						description: 'Nota Fiscal de Serviço eletrônica (NFS-e)',
					},
				],
			},

			// ---------- NFS-e ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'create',
				displayOptions: { show: { resource: ['nfse'] } },
				options: [
					{ name: 'Cancel', value: 'cancel', action: 'Cancel a service invoice' },
					{ name: 'Download PDF', value: 'downloadPdf', action: 'Download the invoice PDF' },
					{ name: 'Download XML', value: 'downloadXml', action: 'Download the invoice XML' },
					{ name: 'Get', value: 'get', action: 'Get a service invoice' },
					{
						name: 'Get Cancellation',
						value: 'getCancellation',
						action: 'Get the cancellation of a service invoice',
						description: 'Read the cancellation event of an invoice that was cancelled',
					},
					{ name: 'Get Many', value: 'getAll', action: 'Get many service invoices' },
					{
						name: 'Issue',
						value: 'create',
						action: 'Issue a service invoice',
						description: 'Submit a service declaration (DPS) and issue the invoice',
					},
					{
						name: 'Preview',
						value: 'preview',
						action: 'Preview a service invoice',
						description:
							'Build and check the payload locally without issuing anything. No API call, no credits, no invoice.',
					},
					{
						name: 'Sync',
						value: 'sync',
						action: 'Sync a service invoice',
						description:
							'Force the city hall to be re-read. Costs 1 credit per call — do not use it to poll, use Get instead.',
					},
				],
			},
			{
				displayName: 'Invoice ID',
				name: 'invoiceId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'nfs_3a233158c3524323878cb1d0b848ba44',
				description: 'Identifier returned when the invoice was issued',
				displayOptions: {
					show: {
						resource: ['nfse'],
						operation: [
							'get',
							'getCancellation',
							'cancel',
							'sync',
							'downloadPdf',
							'downloadXml',
						],
					},
				},
			},
			{
				displayName: 'Put Output File in Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				hint: 'The name of the output binary field to put the file in',
				displayOptions: {
					show: { resource: ['nfse'], operation: ['downloadPdf', 'downloadXml'] },
				},
			},
			{
				displayName:
					'The first download of each file is free; later downloads of the same file may consume 1 credit. Store the file instead of downloading it again.',
				name: 'downloadNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: { resource: ['nfse'], operation: ['downloadPdf', 'downloadXml'] },
				},
			},
			{
				displayName:
					'Syncing costs 1 credit per call. Use it only when an invoice looks stuck — to follow a normal issue, use Get, which is free.',
				name: 'syncNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { resource: ['nfse'], operation: ['sync'] } },
			},
			...nfseCancelFields,
			{
				displayName: 'Service Provider Tax ID',
				name: 'listProviderTaxId',
				type: 'string',
				default: '',
				required: true,
				description:
					'CNPJ of the company whose invoices you want to list. Required by the API. One credential can act for every company registered under your tenant.',
				displayOptions: { show: { resource: ['nfse'], operation: ['getAll'] } },
			},
			{
				displayName: 'External Reference',
				name: 'listReference',
				type: 'string',
				default: '',
				description:
					'Filter by the reference you sent when issuing. Leave empty to list the most recent invoices.',
				displayOptions: { show: { resource: ['nfse'], operation: ['getAll'] } },
			},
			{
				displayName: 'Wait for Authorization',
				name: 'waitForAuthorization',
				type: 'boolean',
				default: false,
				description:
					'Whether to keep checking until the city hall authorizes or denies the invoice. Checking is free, but a slow city can hold the execution open — for production prefer a second scheduled workflow that drains pending invoices.',
				displayOptions: { show: { resource: ['nfse'], operation: ['create'] } },
			},
			{
				displayName: 'Wait Timeout (Seconds)',
				name: 'waitTimeout',
				type: 'number',
				default: 120,
				typeOptions: { minValue: 10, maxValue: 600 },
				displayOptions: {
					show: { resource: ['nfse'], operation: ['create'], waitForAuthorization: [true] },
				},
			},
			...nfseFields,

			// ---------- Company ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'get',
				displayOptions: { show: { resource: ['empresa'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a company' },
					{ name: 'Delete', value: 'delete', action: 'Delete a company' },
					{ name: 'Get', value: 'get', action: 'Get a company' },
					{
						name: 'Get Invoice Settings',
						value: 'getNfseConfig',
						action: 'Get invoice settings',
						description: 'Read the service invoice (NFS-e) settings of the company',
					},
					{ name: 'Get Many', value: 'getAll', action: 'Get many companies' },
					{ name: 'Update', value: 'update', action: 'Update a company' },
					{
						name: 'Update Invoice Settings',
						value: 'updateNfseConfig',
						action: 'Update invoice settings',
						description: 'Set series, numbering and tax regime for service invoices (NFS-e)',
					},
					{
						name: 'Upload Certificate',
						value: 'uploadCertificate',
						action: 'Upload a digital certificate',
						description:
							'Prefer the ACBr API console for this. n8n stores execution data, so the certificate and its password may be kept in the execution history.',
					},
				],
			},
			{
				displayName:
					'Uploading a certificate sends the A1 file and its password through this workflow. n8n saves execution data, so both can remain in the execution history. The recommended path is the ACBr API console; if you automate onboarding, disable execution data retention for this workflow.',
				name: 'certificateNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { resource: ['empresa'], operation: ['uploadCertificate'] } },
			},
			{
				displayName: 'Company Tax ID',
				name: 'companyTaxId',
				type: 'string',
				default: '',
				required: true,
				description: 'CNPJ or CPF of the company, digits only',
				displayOptions: {
					show: {
						resource: ['empresa'],
						operation: [
							'get',
							'update',
							'delete',
							'uploadCertificate',
							'getNfseConfig',
							'updateNfseConfig',
						],
					},
				},
			},
			...empresaFields,

			// ---------- CNPJ ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'get',
				displayOptions: { show: { resource: ['cnpj'] } },
				options: [
					{ name: 'Get', value: 'get', action: 'Get company data by CNPJ' },
					{
						name: 'Get Many',
						value: 'getAll',
						action: 'Get many companies by activity code',
					},
				],
			},
			{
				displayName: 'CNPJ',
				name: 'cnpj',
				type: 'string',
				default: '',
				required: true,
				placeholder: '08421842000190',
				description: 'Company tax ID, digits only',
				displayOptions: { show: { resource: ['cnpj'], operation: ['get'] } },
			},

			// ---------- Postal code ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'get',
				displayOptions: { show: { resource: ['cep'] } },
				options: [{ name: 'Get', value: 'get', action: 'Get an address by postal code' }],
			},
			{
				displayName: 'Postal Code',
				name: 'cep',
				type: 'string',
				default: '',
				required: true,
				placeholder: '80030030',
				description: 'Brazilian postal code (CEP), digits only',
				displayOptions: { show: { resource: ['cep'] } },
			},

			// ---------- Debug ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'getDocument',
				displayOptions: { show: { resource: ['debug'] } },
				options: [
					{
						name: 'Get Document Trace',
						value: 'getDocument',
						action: 'Get the trace of a fiscal document',
					},
					{
						name: 'Get Original Payload',
						value: 'getOriginalPayload',
						action: 'Get the payload originally received',
					},
					{
						name: 'Get HTTP Request Body',
						value: 'getRequestContent',
						action: 'Get the request sent to the city hall',
					},
					{
						name: 'Get HTTP Response Body',
						value: 'getResponseContent',
						action: 'Get the response from the city hall',
					},
				],
			},
			{
				displayName: 'ID',
				name: 'debugId',
				type: 'string',
				default: '',
				required: true,
				description:
					'Fiscal document ID for the trace operations, or the HTTP request ID for the body operations',
				displayOptions: { show: { resource: ['debug'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const retorno: INodeExecutionData[] = [];

		const credencial = await this.getCredentials('acbrApiOAuth2Api');
		// A credential define apenas o HOST. O ambiente fiscal do documento vem
		// por parâmetro, porque uma credential atende N empresas (ver de-para).
		const ambiente = (credencial.environment as string) ?? 'homologacao';
		const baseUrl = BASE_URL[ambiente];
		if (!baseUrl) {
			throw new NodeOperationError(this.getNode(), `Unknown environment: ${ambiente}`);
		}

		const escopos = (credencial.scopes as string[]) ?? [];

		const requisicao = async (
			method: IHttpRequestMethods,
			caminho: string,
			opcoes: Partial<IHttpRequestOptions> = {},
		): Promise<IDataObject> => {
			const options: IHttpRequestOptions = {
				method,
				url: `${baseUrl}${caminho}`,
				json: true,
				...opcoes,
			};
			try {
				return (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'acbrApiOAuth2Api',
					options,
				)) as IDataObject;
			} catch (erro) {
				// O n8n expõe apenas o texto genérico do status. Registra o corpo
				// enviado e a forma bruta do erro, que é onde a API diz o motivo.
				this.logger.error(
					`ACBr API ${method} ${caminho} falhou
  corpo enviado: ${JSON.stringify(opcoes.body ?? null)}
  erro: ${descreverErro(erro)}`,
				);
				// Traduz aqui, na origem: a partir deste ponto todo erro que circula
				// já é NodeOperationError ou NodeApiError, nunca a forma crua.
				throw traduzirErro.call(this, erro);
			}
		};

		/** Baixa arquivo e devolve o item já com o binário anexado. */
		const baixarArquivo = async (
			caminho: string,
			nomeArquivo: string,
			mimeTypePadrao: string,
			i: number,
		): Promise<INodeExecutionData> => {
			const campo = this.getNodeParameter('binaryPropertyName', i) as string;
			const resposta = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				'acbrApiOAuth2Api',
				{
					method: 'GET',
					url: `${baseUrl}${caminho}`,
					json: false,
					encoding: 'arraybuffer',
					returnFullResponse: true,
				},
			)) as { body: Buffer; headers: Record<string, string> };

			const mimeType = resposta.headers?.['content-type']?.split(';')[0] ?? mimeTypePadrao;
			const binario = await this.helpers.prepareBinaryData(
				Buffer.from(resposta.body),
				nomeArquivo,
				mimeType,
			);

			return {
				json: { fileName: nomeArquivo, mimeType, size: binario.fileSize },
				binary: { [campo]: binario },
				pairedItem: { item: i },
			};
		};

		for (let i = 0; i < items.length; i++) {
			const resource = this.getNodeParameter('resource', i) as string;
			const operation = this.getNodeParameter('operation', i) as string;

			// A credencial permite desmarcar escopos (P-39). Falhar aqui, nomeando a
			// caixa, é muito mais útil que repassar o 403 cru da API.
			const escopoNecessario = ESCOPO_POR_RECURSO[resource];
			if (escopoNecessario && escopos.length > 0 && !escopos.includes(escopoNecessario)) {
				throw new NodeOperationError(
					this.getNode(),
					`Your credential is missing the '${escopoNecessario}' scope`,
					{
						description: `Edit the ACBr API credential and enable '${escopoNecessario}' under Scopes.`,
						itemIndex: i,
					},
				);
			}

			try {
				let resultado: IDataObject | IDataObject[] | undefined;

				// Operações que devolvem arquivo saem por aqui, com binário anexado.
				if (resource === 'nfse' && (operation === 'downloadPdf' || operation === 'downloadXml')) {
					const id = this.getNodeParameter('invoiceId', i) as string;
					const pdf = operation === 'downloadPdf';
					retorno.push(
						await baixarArquivo(
							`/nfse/${id}/${pdf ? 'pdf' : 'xml'}`,
							`${id}.${pdf ? 'pdf' : 'xml'}`,
							pdf ? 'application/pdf' : 'application/xml',
							i,
						),
					);
					continue;
				}

				if (resource === 'cep' && operation === 'get') {
					const cep = (this.getNodeParameter('cep', i) as string).replace(/\D/g, '');
					resultado = await requisicao('GET', `/cep/${cep}`);
				} else if (resource === 'cnpj' && operation === 'get') {
					const cnpj = (this.getNodeParameter('cnpj', i) as string).replace(/\D/g, '');
					resultado = await requisicao('GET', `/cnpj/${cnpj}`);
				} else if (resource === 'nfse' && (operation === 'create' || operation === 'preview')) {
					const corpo = montarPayloadNfse.call(this, i);

					// A credencial escolhe o HOST e o campo Environment vai dentro do
					// documento. Divergindo, o DPS sai com um tpAmb que não é o do host
					// — falha longe daqui, com mensagem do município. Barra antes.
					if (corpo.ambiente !== ambiente) {
						throw new NodeOperationError(
							this.getNode(),
							'The Environment of this operation does not match the environment of the credential',
							{
								description: `The credential points at ${ambiente}, the operation is set to ${String(corpo.ambiente)}. Credentials are issued per environment and are not interchangeable — set both to the same value.`,
								itemIndex: i,
							},
						);
					}

					if (operation === 'preview') {
						// Conferência local: nenhuma chamada de rede, nenhum crédito, nenhuma
						// nota. Não mostra o ISS — quem calcula é o município.
						resultado = { preview: true, payload: corpo };
					} else {
						resultado = await emitirComReplay.call(this, requisicao, corpo);

						const aguardar = this.getNodeParameter('waitForAuthorization', i, false) as boolean;
						if (aguardar && resultado.status === STATUS_EM_ANDAMENTO) {
							const timeout = this.getNodeParameter('waitTimeout', i, 120) as number;
							resultado = await aguardarConclusao.call(this, requisicao, resultado, timeout);
						}
					}
				} else if (resource === 'nfse' && operation === 'get') {
					const id = this.getNodeParameter('invoiceId', i) as string;
					resultado = await requisicao('GET', `/nfse/${id}`);
				} else if (resource === 'nfse' && operation === 'sync') {
					// Cobra 1 unidade por requisição. Operação explícita de propósito —
					// o acompanhamento normal usa Get, que é gratuito.
					const id = this.getNodeParameter('invoiceId', i) as string;
					resultado = await requisicao('POST', `/nfse/${id}/sincronizar`);
				} else if (resource === 'nfse' && operation === 'cancel') {
					const id = this.getNodeParameter('invoiceId', i) as string;
					// Nenhum campo do corpo é obrigatório — só algumas prefeituras exigem.
					// Collection vazia significa requisição sem corpo.
					const informados = this.getNodeParameter('nfseCancellation', i, {}) as IDataObject;
					const corpo: IDataObject = {};
					for (const [nomeParametro, campo] of Object.entries(NFSE_CANCEL_PATHS)) {
						const valor = informados[nomeParametro];
						if (valor !== undefined && valor !== '') corpo[campo] = valor;
					}
					const opcoes: Partial<IHttpRequestOptions> =
						Object.keys(corpo).length > 0 ? { body: corpo } : {};
					resultado = await requisicao('POST', `/nfse/${id}/cancelamento`, opcoes);
				} else if (resource === 'nfse' && operation === 'getCancellation') {
					const id = this.getNodeParameter('invoiceId', i) as string;
					resultado = await requisicao('GET', `/nfse/${id}/cancelamento`);
				} else if (resource === 'nfse' && operation === 'getAll') {
					// ListarNfse exige cpf_cnpj e ambiente. O CNPJ é por execução: um
					// tenant de software house lista as notas de cada empresa atendida.
					const cpfCnpj = (this.getNodeParameter('listProviderTaxId', i) as string).replace(
						/\D/g,
						'',
					);
					const referencia = this.getNodeParameter('listReference', i, '') as string;
					const qs: IDataObject = { cpf_cnpj: cpfCnpj, ambiente };
					if (referencia) qs.referencia = referencia;
					const lista = await requisicao('GET', '/nfse', { qs });
					resultado = (lista.data as IDataObject[] | undefined) ?? [];
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`Operation '${operation}' on resource '${resource}' is not implemented yet`,
						{
							description:
								'This version covers the service invoice (NFS-e) operations and the CNPJ and postal code lookups.',
							itemIndex: i,
						},
					);
				}

				const saida = Array.isArray(resultado) ? resultado : [resultado ?? {}];
				retorno.push(
					...saida.map((json) => ({ json, pairedItem: { item: i } }) as INodeExecutionData),
				);
			} catch (erro) {
				if (this.continueOnFail()) {
					retorno.push({ json: { error: (erro as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw traduzirErro.call(this, erro);
			}
		}

		return [retorno];
	}
}

/** Monta o corpo do DPS a partir do FIELD_PATHS — sem código por campo. */
function montarPayloadNfse(this: IExecuteFunctions, i: number): IDataObject {
	const corpo: IDataObject = {};

	// Sete chaves do NFSE_PATHS não existem como parâmetro de topo: vivem dentro
	// das collections nfseTotalTaxes e nfseIbscbs. O n8n descarta qualquer chave
	// fora do schema, então não há como supri-las pelo JSON do workflow — tem de
	// ser lido daqui. Mesmo padrão já usado em nfseCancellation.
	const deCollection: IDataObject = {
		...(this.getNodeParameter('nfseTotalTaxes', i, {}) as IDataObject),
		...(this.getNodeParameter('nfseIbscbs', i, {}) as IDataObject),
	};

	for (const [nomeParametro, caminho] of Object.entries(NFSE_PATHS)) {
		// Fallback '' e não undefined: undefined faz o n8n lançar
		// "Could not get parameter" em todo opcional que o usuário não preencheu.
		const valor =
			nomeParametro in deCollection
				? deCollection[nomeParametro]
				: this.getNodeParameter(nomeParametro, i, '');
		setByPath(corpo, caminho, valor);
	}

	// Preenchidos pelo node, nunca expostos.
	setByPath(corpo, 'provedor', 'nacional');

	// tpAmb é a forma codificada do 'ambiente' que o chamador informou — o node
	// transcreve, não decide. O valor vem do parâmetro via NFSE_PATHS.
	setByPath(corpo, 'infDPS.tpAmb', corpo.ambiente === 'producao' ? 1 : 2);
	setByPath(corpo, 'infDPS.verAplic', VER_APLIC);
	if (!(corpo.infDPS as IDataObject)?.dhEmi) {
		setByPath(corpo, 'infDPS.dhEmi', new Date().toISOString());
	}

	return corpo;
}

/**
 * Emite tratando o 400 de referência duplicada como replay, não como falha.
 *
 * Propagar esse erro faz o usuário reemitir com outra referência e produz
 * exatamente a duplicata que a restrição da API impede.
 */
async function emitirComReplay(
	this: IExecuteFunctions,
	requisicao: (
		method: IHttpRequestMethods,
		caminho: string,
		opcoes?: Partial<IHttpRequestOptions>,
	) => Promise<IDataObject>,
	corpo: IDataObject,
): Promise<IDataObject> {
	try {
		return await requisicao('POST', '/nfse/dps', { body: corpo });
	} catch (erro) {
		// `requisicao` já devolve erro de node; isto é só a garantia de tipo.
		const falha = comoErroDeNode.call(this, erro);
		if (!eReferenciaDuplicada(erro)) throw falha;

		const referencia = corpo.referencia as string | undefined;
		const cpfCnpj = ((corpo.infDPS as IDataObject)?.prest as IDataObject)?.CNPJ as string;
		if (!referencia) throw falha;

		const lista = await requisicao('GET', '/nfse', {
			qs: { cpf_cnpj: cpfCnpj, ambiente: corpo.ambiente as string, referencia },
		});
		const existente = (lista.data as IDataObject[] | undefined)?.[0];
		if (!existente) throw falha;

		this.logger.info(
			`ACBr API: reference '${referencia}' already used; returning the existing invoice instead of issuing a new one.`,
		);
		return { ...existente, alreadyIssued: true };
	}
}

async function aguardarConclusao(
	this: IExecuteFunctions,
	requisicao: (
		method: IHttpRequestMethods,
		caminho: string,
		opcoes?: Partial<IHttpRequestOptions>,
	) => Promise<IDataObject>,
	nota: IDataObject,
	timeoutSegundos: number,
): Promise<IDataObject> {
	const id = nota.id as string;
	const limite = Date.now() + timeoutSegundos * 1000;
	let atual = nota;

	while (atual.status === STATUS_EM_ANDAMENTO && Date.now() < limite) {
		await sleep(5000);
		// Consultar não tem consumo documentado; Sincronizar cobra 1 unidade por
		// requisição e por isso nunca é usado em laço.
		atual = await requisicao('GET', `/nfse/${id}`);
	}

	if (atual.status === STATUS_EM_ANDAMENTO) {
		atual.timedOut = true;
		this.logger.warn(
			`ACBr API: invoice ${id} was still processing after ${timeoutSegundos}s. It may still be authorized later — check it with the Get operation.`,
		);
	}

	return atual;
}

/**
 * O erro chega aqui já traduzido por `traduzirErro`, então a mensagem é o texto
 * em inglês do de-para e a frase original da API vive na `description`. Procura
 * nas duas: o trecho em pt-BR é específico o bastante para identificar sozinho,
 * e depender do status 400 deixou de ser possível — NodeOperationError não
 * carrega httpCode.
 */
function eReferenciaDuplicada(erro: unknown): boolean {
	const e = erro as { message?: string; description?: string };
	const { apiMessagePt, displayMessage } = ERROR_MAP.referenciaDuplicada;
	const texto = `${e.message ?? ''} ${e.description ?? ''}`;
	return texto.includes(apiMessagePt) || texto.includes(displayMessage);
}

/** Garantia de tipo: o que sai daqui é sempre erro de node, nunca forma crua. */
function comoErroDeNode(this: IExecuteFunctions, erro: unknown): Error {
	if (erro instanceof NodeApiError || erro instanceof NodeOperationError) return erro;
	return new NodeApiError(this.getNode(), erro as JsonObject);
}

/** Substitui a mensagem crua da API pelo texto mapeado no de-para (P-17). */
/**
 * Extrai o corpo da resposta de erro da API.
 *
 * O n8n põe em 'message' apenas o texto genérico do status ("Bad request -
 * please check your parameters"). O motivo real — qual campo o município
 * recusou — vem no corpo, e sem isto o usuário fica sem nada acionável.
 */
/** Dump de diagnóstico: revela a forma real do erro para os logs. */
function descreverErro(erro: unknown): string {
	const e = (erro ?? {}) as Record<string, unknown>;
	const partes: string[] = [`keys=[${Object.keys(e).join(',')}]`];

	for (const chave of ['message', 'httpCode', 'statusCode', 'description', 'error']) {
		const valor = e[chave];
		if (valor === undefined) continue;
		partes.push(`${chave}=${typeof valor === 'object' ? JSON.stringify(valor) : String(valor)}`);
	}

	const causa = e.cause as Record<string, unknown> | undefined;
	if (causa) partes.push(`causeKeys=[${Object.keys(causa).join(',')}]`);

	const resposta = (e.response ?? causa?.response) as
		| { status?: unknown; body?: unknown; data?: unknown }
		| undefined;
	if (resposta) {
		partes.push(
			`response=${JSON.stringify({
				status: resposta.status,
				body: resposta.body,
				data: resposta.data,
			})}`,
		);
	}

	return partes.join("\n    ");
}

function detalheDaApi(erro: unknown): string {
	const corpoDe = (o: unknown): unknown => {
		const alvo = o as { body?: unknown; data?: unknown } | undefined;
		return alvo?.body ?? alvo?.data;
	};
	const raiz = erro as
		| { response?: unknown; cause?: { response?: unknown }; error?: unknown; description?: unknown }
		| undefined;

	const candidatos: unknown[] = [
		corpoDe(raiz?.response),
		corpoDe(raiz?.cause?.response),
		raiz?.error,
		raiz?.description,
	];

	for (const candidato of candidatos) {
		if (!candidato) continue;
		if (typeof candidato === 'string' && candidato.trim()) return candidato.trim();
		if (typeof candidato === 'object') return JSON.stringify(candidato);
	}
	return '';
}

function traduzirErro(this: IExecuteFunctions, erro: unknown): Error {
	// Idempotente: `requisicao` já traduz na origem, e o catch do laço de itens
	// passa por aqui de novo. Reembrulhar produziria "mensagem — mensagem".
	// Ainda é necessário para os erros crus de `baixarArquivo`, que chama o
	// helper HTTP direto.
	if (erro instanceof NodeOperationError || erro instanceof NodeApiError) return erro;

	const e = erro as { message?: string; httpCode?: string; statusCode?: number };
	const mensagem = String(e.message ?? '');
	const status = Number(e.httpCode ?? e.statusCode);
	const detalhe = detalheDaApi(erro);
	const completa = detalhe ? `${mensagem} — ${detalhe}` : mensagem;

	for (const entrada of Object.values(ERROR_MAP)) {
		const casaMensagem = entrada.apiMessagePt && completa.includes(entrada.apiMessagePt);
		const casaCodigo = entrada.apiCode && completa.includes(entrada.apiCode);
		const casaStatus = entrada.httpStatus && entrada.httpStatus === status;
		if (casaMensagem || casaCodigo || (casaStatus && !entrada.apiMessagePt && !entrada.apiCode)) {
			return new NodeOperationError(this.getNode(), entrada.displayMessage, {
				description: completa,
			});
		}
	}

	// Sem mapeamento: propaga o motivo da API na própria mensagem, senão o
	// usuário recebe só o texto genérico do status.
	if (detalhe) {
		return new NodeOperationError(this.getNode(), completa, { description: detalhe });
	}
	return comoErroDeNode.call(this, erro);
}
