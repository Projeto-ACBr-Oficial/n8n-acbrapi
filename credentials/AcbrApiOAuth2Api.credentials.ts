import type { ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * Credencial OAuth2 client_credentials da ACBr API.
 *
 * O ponto central: o endpoint de token da ACBr API aceita apenas
 * 4 requisições por hora. Execuções de n8n são stateless, então o padrão
 * ingênuo — pedir token dentro do workflow — estoura o limite em minutos.
 * Estendendo `oAuth2Api`, o token passa a viver no credential store do n8n,
 * que o reaproveita e renova perto de `expires_in` (~30 dias).
 *
 * Não remova o `extends`: é ele que dá acesso a esse cache.
 */
export class AcbrApiOAuth2Api implements ICredentialType {
	name = 'acbrApiOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'ACBr API OAuth2 API';

	icon = 'file:acbrApi.svg' as const;

	documentationUrl = 'https://dev.acbr.api.br/docs/autenticacao';

	/**
	 * Teste de conexão da credencial.
	 *
	 * Roda a consulta de CEP: é o endpoint mais barato que exige um token válido,
	 * não depende de empresa cadastrada nem de certificado, e responde em
	 * milissegundos. Custa 0,1 crédito por teste.
	 *
	 * Em troca, depende do escopo 'cep'. Quem desmarcar esse escopo recebe 403 no
	 * teste mesmo com credencial correta — daí a regra abaixo, que troca o 403
	 * cru por uma frase que diz o que houve.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL:
				'={{ $credentials.environment === "producao" ? "https://prod.acbr.api.br" : "https://hom.acbr.api.br" }}',
			url: '/cep/01001000',
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						"The credentials are valid, but this credential does not have the 'Postal Code Lookup' scope, which the connection test uses. Enable it below, or ignore this if you do not need postal code lookups.",
				},
			},
		],
	};

	properties: INodeProperties[] = [
		{
			displayName: 'Environment',
			name: 'environment',
			type: 'options',
			default: 'homologacao',
			description:
				'Which ACBr API environment to use. Credentials are issued per environment and are not interchangeable.',
			options: [
				{
					name: 'Staging',
					value: 'homologacao',
					description: 'https://hom.acbr.api.br — use this while developing',
				},
				{
					name: 'Production',
					value: 'producao',
					description: 'https://prod.acbr.api.br — issues real fiscal documents',
				},
			],
		},
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			required: true,
			description: 'Client ID created in the ACBr API console',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Client secret created in the ACBr API console',
		},
		{
			displayName: 'Scopes',
			name: 'scopes',
			type: 'multiOptions',
			default: ['nfse', 'cnpj', 'cep'],
			description:
				'Which parts of the API this credential may reach. Leave all selected unless you want to restrict it — a request to an endpoint outside the selected scopes fails with HTTP 403.',
			// Só os escopos que o 1.0 usa. Os de 'empresa' e 'debug' voltam junto com
			// as operações; quem atualizar precisará reabrir a credential para marcá-los,
			// porque o token em cache é emitido com os escopos vigentes na criação.
			options: [
				{ name: 'Service Invoices (NFS-e)', value: 'nfse' },
				{ name: 'CNPJ Lookup', value: 'cnpj' },
				{ name: 'Postal Code Lookup', value: 'cep' },
			],
		},

		// --- Abaixo: preenchido pela credencial, não exposto ao usuário. ---

		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'clientCredentials',
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			// Idêntico nos dois ambientes — só a URL base da API muda.
			default: 'https://auth.acbr.api.br/realms/ACBrAPI/protocol/openid-connect/token',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			// A ACBr API espera os escopos separados por espaço. A lista vem dos
			// checkboxes acima.
			//
			// VERIFICAR NA PRIMEIRA EXECUÇÃO: se a camada de credenciais não
			// avaliar `$self` aqui, troque este campo por um `string` editável com
			// default 'nfse cnpj cep'. O comportamento aparece no log
			// da requisição de token (rode com N8N_LOG_LEVEL=debug).
			default: '={{ ($self.scopes || []).join(" ") }}',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'body',
		},
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: '',
		},
	];
}
