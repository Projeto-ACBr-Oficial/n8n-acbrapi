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

const APPLICATION_VERSION = 'n8n-acbrapi/1.0.3';

const STATUS_IN_PROGRESS = 'processando';

const SCOPE_BY_RESOURCE: Record<string, string> = {
	nfse: 'nfse',
	empresa: 'empresa',
	cnpj: 'cnpj',
	cep: 'cep',
	debug: 'debug',
};

/**
 * Writes a value into a nested object, creating the intermediate levels.
 *
 * Empty values are skipped so that optional parameters left blank never reach
 * the payload.
 *
 * @param target Object to write into.
 * @param path Dot-separated path, as used by NFSE_PATHS.
 * @param value Value to set; undefined, null and '' are ignored.
 */
function setByPath(target: IDataObject, path: string, value: unknown): void {
	if (value === undefined || value === null || value === '') return;
	const parts = path.split('.');
	let current: IDataObject = target;
	for (const part of parts.slice(0, -1)) {
		if (typeof current[part] !== 'object' || current[part] === null) current[part] = {};
		current = current[part] as IDataObject;
	}
	current[parts[parts.length - 1]] = value as IDataObject[string];
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
				options: [
					{ name: 'CNPJ', value: 'cnpj' },
					{ name: 'Postal Code', value: 'cep' },
					{
						name: 'Service Invoice',
						value: 'nfse',
						description: 'Brazilian electronic service invoice (NFS-e)',
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
				options: [{ name: 'Get', value: 'get', action: 'Get company data by CNPJ' }],
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
		const output: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('acbrApiOAuth2Api');
		const environment = (credentials.environment as string) ?? 'homologacao';
		const baseUrl = BASE_URL[environment];
		if (!baseUrl) {
			throw new NodeOperationError(this.getNode(), `Unknown environment: ${environment}`);
		}

		const scopes = (credentials.scopes as string[]) ?? [];

		const request = async (
			method: IHttpRequestMethods,
			path: string,
			extraOptions: Partial<IHttpRequestOptions> = {},
		): Promise<IDataObject> => {
			const options: IHttpRequestOptions = {
				method,
				url: `${baseUrl}${path}`,
				json: true,
				...extraOptions,
			};
			try {
				return (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'acbrApiOAuth2Api',
					options,
				)) as IDataObject;
			} catch (error) {
				this.logger.error(
					`ACBr API ${method} ${path} falhou body enviado: ${JSON.stringify(extraOptions.body ?? null)} error: ${describeError(error)}`,
				);
				throw translateError.call(this, error);
			}
		};
		const downloadFile = async (
			path: string,
			fileName: string,
			defaultMimeType: string,
			i: number,
		): Promise<INodeExecutionData> => {
			const field = this.getNodeParameter('binaryPropertyName', i) as string;
			const response = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				'acbrApiOAuth2Api',
				{
					method: 'GET',
					url: `${baseUrl}${path}`,
					json: false,
					encoding: 'arraybuffer',
					returnFullResponse: true,
				},
			)) as { body: Buffer; headers: Record<string, string> };

			const mimeType = response.headers?.['content-type']?.split(';')[0] ?? defaultMimeType;
			const binary = await this.helpers.prepareBinaryData(
				Buffer.from(response.body),
				fileName,
				mimeType,
			);

			return {
				json: { fileName: fileName, mimeType, size: binary.fileSize },
				binary: { [field]: binary },
				pairedItem: { item: i },
			};
		};

		for (let i = 0; i < items.length; i++) {
			const resource = this.getNodeParameter('resource', i) as string;
			const operation = this.getNodeParameter('operation', i) as string;

			const requiredScope = SCOPE_BY_RESOURCE[resource];
			if (requiredScope && scopes.length > 0 && !scopes.includes(requiredScope)) {
				throw new NodeOperationError(
					this.getNode(),
					`Your credential is missing the '${requiredScope}' scope`,
					{
						description: `Edit the ACBr API credential and enable '${requiredScope}' under Scopes.`,
						itemIndex: i,
					},
				);
			}

			try {
				let result: IDataObject | IDataObject[] | undefined;

				if (resource === 'nfse' && (operation === 'downloadPdf' || operation === 'downloadXml')) {
					const id = this.getNodeParameter('invoiceId', i) as string;
					const pdf = operation === 'downloadPdf';
					output.push(
						await downloadFile(
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
					result = await request('GET', `/cep/${cep}`);
				} else if (resource === 'cnpj' && operation === 'get') {
					const cnpj = (this.getNodeParameter('cnpj', i) as string).replace(/\D/g, '');
					result = await request('GET', `/cnpj/${cnpj}`);
				} else if (resource === 'nfse' && (operation === 'create' || operation === 'preview')) {
					const body = buildInvoicePayload.call(this, i);

					if (body.ambiente !== environment) {
						throw new NodeOperationError(
							this.getNode(),
							'The Environment of this operation does not match the environment of the credential',
							{
								description: `The credential points at ${environment}, the operation is set to ${String(body.ambiente)}. Credentials are issued per environment and are not interchangeable — set both to the same value.`,
								itemIndex: i,
							},
						);
					}

					if (operation === 'preview') {
						result = { preview: true, payload: body };
					} else {
						result = await issueWithReplay.call(this, request, body);

						const wait = this.getNodeParameter('waitForAuthorization', i, false) as boolean;
						if (wait && result.status === STATUS_IN_PROGRESS) {
							const timeout = this.getNodeParameter('waitTimeout', i, 120) as number;
							result = await waitForCompletion.call(this, request, result, timeout);
						}
					}
				} else if (resource === 'nfse' && operation === 'get') {
					const id = this.getNodeParameter('invoiceId', i) as string;
					result = await request('GET', `/nfse/${id}`);
				} else if (resource === 'nfse' && operation === 'sync') {
					const id = this.getNodeParameter('invoiceId', i) as string;
					result = await request('POST', `/nfse/${id}/sincronizar`);
				} else if (resource === 'nfse' && operation === 'cancel') {
					const id = this.getNodeParameter('invoiceId', i) as string;
					const provided = this.getNodeParameter('nfseCancellation', i, {}) as IDataObject;
					const body: IDataObject = {};
					for (const [parameterName, field] of Object.entries(NFSE_CANCEL_PATHS)) {
						const value = provided[parameterName];
						if (value !== undefined && value !== '') body[field] = value;
					}
					const extraOptions: Partial<IHttpRequestOptions> =
						Object.keys(body).length > 0 ? { body: body } : {};
					result = await request('POST', `/nfse/${id}/cancelamento`, extraOptions);
				} else if (resource === 'nfse' && operation === 'getCancellation') {
					const id = this.getNodeParameter('invoiceId', i) as string;
					result = await request('GET', `/nfse/${id}/cancelamento`);
				} else if (resource === 'nfse' && operation === 'getAll') {
					const cpfCnpj = (this.getNodeParameter('listProviderTaxId', i) as string).replace(
						/\D/g,
						'',
					);
					const reference = this.getNodeParameter('listReference', i, '') as string;
					const qs: IDataObject = { cpf_cnpj: cpfCnpj, ambiente: environment };
					if (reference) qs.reference = reference;
					const list = await request('GET', '/nfse', { qs });
					result = (list.data as IDataObject[] | undefined) ?? [];
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

				const entries = Array.isArray(result) ? result : [result ?? {}];
				output.push(
					...entries.map((json) => ({ json, pairedItem: { item: i } }) as INodeExecutionData),
				);
			} catch (error) {
				if (this.continueOnFail()) {
					output.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw translateError.call(this, error);
			}
		}

		return [output];
	}
}

/**
 * Builds the service declaration (DPS) body from the node parameters.
 *
 * The mapping between parameter and JSON path lives in NFSE_PATHS, generated
 * from de-para/, so no field is hand-coded here. Seven keys live inside the
 * Estimated Taxes and IBS/CBS collections rather than at the top level, and n8n
 * discards anything outside the schema, so they are read from the collections
 * first.
 *
 * Fields the node fills in itself are not exposed: the provider, the coded
 * environment and the application version. The issue date defaults to now.
 *
 * @param i Index of the item being processed.
 * @returns The request body for POST /nfse/dps.
 */
function buildInvoicePayload(this: IExecuteFunctions, i: number): IDataObject {
	const body: IDataObject = {};

	const fromCollections: IDataObject = {
		...(this.getNodeParameter('nfseTotalTaxes', i, {}) as IDataObject),
		...(this.getNodeParameter('nfseIbscbs', i, {}) as IDataObject),
	};

	for (const [parameterName, path] of Object.entries(NFSE_PATHS)) {
		const value =
			parameterName in fromCollections
				? fromCollections[parameterName]
				: this.getNodeParameter(parameterName, i, '');
		setByPath(body, path, value);
	}

	setByPath(body, 'provedor', 'nacional');

	setByPath(body, 'infDPS.tpAmb', body.ambiente === 'producao' ? 1 : 2);
	setByPath(body, 'infDPS.verAplic', APPLICATION_VERSION);
	if (!(body.infDPS as IDataObject)?.dhEmi) {
		setByPath(body, 'infDPS.dhEmi', new Date().toISOString());
	}

	return body;
}

/**
 * Issues an invoice, treating a duplicate reference as a replay, not a failure.
 *
 * The API enforces uniqueness on the external reference. When a request was
 * processed but its response was lost, retrying returns HTTP 400. Propagating
 * that error makes the caller reissue under a new reference and produces
 * exactly the duplicate the constraint exists to prevent, so the invoice that
 * already exists is fetched and returned flagged instead.
 *
 * @param request Authenticated HTTP helper bound to the selected environment.
 * @param body The declaration body to submit.
 * @returns The issued invoice, or the pre-existing one with alreadyIssued set.
 */
async function issueWithReplay(
	this: IExecuteFunctions,
	request: (
		method: IHttpRequestMethods,
		path: string,
		extraOptions?: Partial<IHttpRequestOptions>,
	) => Promise<IDataObject>,
	body: IDataObject,
): Promise<IDataObject> {
	try {
		return await request('POST', '/nfse/dps', { body: body });
	} catch (error) {
		const failure = toNodeError.call(this, error);
		if (!isDuplicateReference(error)) throw failure;

		const reference = body.referencia as string | undefined;
		const cpfCnpj = ((body.infDPS as IDataObject)?.prest as IDataObject)?.CNPJ as string;
		if (!reference) throw failure;

		const list = await request('GET', '/nfse', {
			qs: { cpf_cnpj: cpfCnpj, ambiente: body.ambiente as string, referencia: reference },
		});
		const existing = (list.data as IDataObject[] | undefined)?.[0];
		if (!existing) throw failure;

		this.logger.info(
			`ACBr API: reference '${reference}' already used; returning the existing invoice instead of issuing a new one.`,
		);
		return { ...existing, alreadyIssued: true };
	}
}

/**
 * Polls an invoice until the city hall authorizes it or the timeout expires.
 *
 * Polling uses Get, which is free; Sync charges one credit per call and is
 * never used in a loop. A timed-out invoice is returned flagged rather than
 * raised, because it may still be authorized later.
 *
 * @param request Authenticated HTTP helper bound to the selected environment.
 * @param invoice The invoice as returned by the issue call.
 * @param timeoutSeconds How long to keep checking before giving up.
 * @returns The last state read, with timedOut set if it never settled.
 */
async function waitForCompletion(
	this: IExecuteFunctions,
	request: (
		method: IHttpRequestMethods,
		path: string,
		extraOptions?: Partial<IHttpRequestOptions>,
	) => Promise<IDataObject>,
	invoice: IDataObject,
	timeoutSeconds: number,
): Promise<IDataObject> {
	const id = invoice.id as string;
	const deadline = Date.now() + timeoutSeconds * 1000;
	let current = invoice;

	while (current.status === STATUS_IN_PROGRESS && Date.now() < deadline) {
		await sleep(5000);
		current = await request('GET', `/nfse/${id}`);
	}

	if (current.status === STATUS_IN_PROGRESS) {
		current.timedOut = true;
		this.logger.warn(
			`ACBr API: invoice ${id} was still processing after ${timeoutSeconds}s. It may still be authorized later — check it with the Get operation.`,
		);
	}

	return current;
}

/**
 * Detects the duplicate-reference rejection on an already translated error.
 *
 * By the time an error reaches here it carries the mapped English message and
 * the API's original Portuguese sentence in the description, so both are
 * searched. The HTTP status is not available: NodeOperationError does not
 * carry one.
 *
 * @param error The error thrown by the request helper.
 */
function isDuplicateReference(error: unknown): boolean {
	const e = error as { message?: string; description?: string };
	const { apiMessagePt, displayMessage } = ERROR_MAP.referenciaDuplicada;
	const texto = `${e.message ?? ''} ${e.description ?? ''}`;
	return texto.includes(apiMessagePt) || texto.includes(displayMessage);
}

/**
 * Guarantees a node error: wraps anything that is not already one.
 *
 * @param error The value caught.
 */
function toNodeError(this: IExecuteFunctions, error: unknown): Error {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	return new NodeApiError(this.getNode(), error as JsonObject);
}

/**
 * Renders an error's real shape for the log.
 *
 * n8n surfaces only the generic status text, so the keys, the nested cause and
 * the response body are dumped to make a rejection diagnosable.
 *
 * @param error The value caught.
 */
function describeError(error: unknown): string {
	const e = (error ?? {}) as Record<string, unknown>;
	const parts: string[] = [`keys=[${Object.keys(e).join(',')}]`];

	for (const key of ['message', 'httpCode', 'statusCode', 'description', 'error']) {
		const value = e[key];
		if (value === undefined) continue;
		parts.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
	}

	const cause = e.cause as Record<string, unknown> | undefined;
	if (cause) parts.push(`causeKeys=[${Object.keys(cause).join(',')}]`);

	const response = (e.response ?? cause?.response) as
		| { status?: unknown; body?: unknown; data?: unknown }
		| undefined;
	if (response) {
		parts.push(
			`response=${JSON.stringify({
				status: response.status,
				body: response.body,
				data: response.data,
			})}`,
		);
	}

	return parts.join('\n    ');
}

/**
 * Extracts the reason the API gave, from wherever it ended up.
 *
 * The body travels in a different place depending on how the request failed,
 * so the known positions are tried in order.
 *
 * @param error The value caught.
 * @returns The API's own explanation, or an empty string.
 */
function apiErrorDetail(error: unknown): string {
	const bodyOf = (o: unknown): unknown => {
		const target = o as { body?: unknown; data?: unknown } | undefined;
		return target?.body ?? target?.data;
	};
	const root = error as
		| { response?: unknown; cause?: { response?: unknown }; error?: unknown; description?: unknown }
		| undefined;

	const candidates: unknown[] = [
		bodyOf(root?.response),
		bodyOf(root?.cause?.response),
		root?.error,
		root?.description,
	];

	for (const candidate of candidates) {
		if (!candidate) continue;
		if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
		if (typeof candidate === 'object') return JSON.stringify(candidate);
	}
	return '';
}

/**
 * Replaces the API's raw message with the mapped text from de-para/.
 *
 * Idempotent: the request helper already translates at the source and the item
 * loop passes errors through here again, so an error that is already a node
 * error is returned untouched. Downloads call the HTTP helper directly and do
 * still arrive raw, which is why this stays on that path.
 *
 * @param error The value caught.
 * @returns A NodeOperationError or NodeApiError, never a raw error.
 */
function translateError(this: IExecuteFunctions, error: unknown): Error {
	if (error instanceof NodeOperationError || error instanceof NodeApiError) return error;

	const e = error as { message?: string; httpCode?: string; statusCode?: number };
	const message = String(e.message ?? '');
	const status = Number(e.httpCode ?? e.statusCode);
	const detail = apiErrorDetail(error);
	const full = detail ? `${message} — ${detail}` : message;

	for (const entry of Object.values(ERROR_MAP)) {
		const messageMatches = entry.apiMessagePt && full.includes(entry.apiMessagePt);
		const codeMatches = entry.apiCode && full.includes(entry.apiCode);
		const statusMatches = entry.httpStatus && entry.httpStatus === status;
		if (messageMatches || codeMatches || (statusMatches && !entry.apiMessagePt && !entry.apiCode)) {
			return new NodeOperationError(this.getNode(), entry.displayMessage, {
				description: full,
			});
		}
	}

	if (detail) {
		return new NodeOperationError(this.getNode(), full, { description: detail });
	}
	return toNodeError.call(this, error);
}