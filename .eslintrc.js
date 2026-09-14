/**
 * Configuração de lint exigida pela verificação de community nodes do n8n.
 * O plugin eslint-plugin-n8n-nodes-base valida convenções de UI, nomes de
 * parâmetro e textos — inclusive a exigência de inglês na interface.
 */
module.exports = {
	root: true,
	env: {
		browser: false,
		es2022: true,
		node: true,
	},
	parser: '@typescript-eslint/parser',
	parserOptions: {
		ecmaVersion: 2022,
		sourceType: 'module',
	},
	ignorePatterns: ['.eslintrc.js', 'dist/**', 'node_modules/**', 'scripts/**'],
	overrides: [
		{
			files: ['package.json'],
			plugins: ['eslint-plugin-n8n-nodes-base'],
			extends: ['plugin:n8n-nodes-base/community'],
			rules: {
				'n8n-nodes-base/community-package-json-name-still-default': 'off',
			},
		},
		{
			files: ['./credentials/**/*.ts'],
			plugins: ['eslint-plugin-n8n-nodes-base'],
			extends: ['plugin:n8n-nodes-base/credentials'],
		},
		{
			files: ['./nodes/**/*.ts'],
			plugins: ['eslint-plugin-n8n-nodes-base'],
			extends: ['plugin:n8n-nodes-base/nodes'],
			rules: {
				// properties.generated.ts é gerado do de-para; a fonte de verdade
				// dos textos é de-para/*.json, não o arquivo emitido.
				'n8n-nodes-base/node-param-description-miscased-json': 'off',
			},
		},
	],
};
