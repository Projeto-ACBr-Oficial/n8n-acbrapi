import type { ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * OAuth 2 client_credentials credential for the ACBr API.
 *
 * The ACBr token endpoint allows only 4 requests per hour. n8n executions are
 * stateless, so requesting a token inside the workflow exhausts that limit
 * within minutes. Extending `oAuth2Api` puts the token in n8n's credential
 * store, which reuses it and renews it near `expires_in` (about 30 days).
 *
 * Do not remove the `extends`: it is what grants access to that cache.
 */
export class AcbrApiOAuth2Api implements ICredentialType {
	name = 'acbrApiOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'ACBr API OAuth2 API';

	icon = 'file:acbrApi.svg' as const;

	documentationUrl = 'https://dev.acbr.api.br/docs/autenticacao';

	/**
	 * Connection test shown when the credential is saved.
	 *
	 * Runs the postal code lookup: the cheapest endpoint that requires a valid
	 * token, independent of any registered company or certificate, answering in
	 * milliseconds at 0.1 credit per test.
	 *
	 * It does depend on the 'cep' scope, so unchecking that scope returns 403
	 * even with correct credentials. The rule below replaces that bare 403 with
	 * a sentence explaining what happened.
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
			options: [
				{ name: 'Service Invoices (NFS-e)', value: 'nfse' },
				{ name: 'CNPJ Lookup', value: 'cnpj' },
				{ name: 'Postal Code Lookup', value: 'cep' },
			],
		},
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
			default: 'https://auth.acbr.api.br/realms/ACBrAPI/protocol/openid-connect/token',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
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
