/**
 * The lint gate of n8n verification.
 *
 * This mirrors, rule for rule, the configuration that
 * `@n8n/scan-community-package` builds when a submitted node is scanned — the
 * two plugins, the three rulesets of the older one and the same
 * off-overrides. A clean `npm run lint` here therefore means a clean scan
 * there, which is the whole point: the previous setup ran only
 * eslint-plugin-n8n-nodes-base and let seven errors through to the reviewer.
 *
 * Keep it in step with the scanner. If a release fails the automated vetting
 * on a rule that passes here, this file is what drifted.
 */
import { defineConfig } from 'eslint/config';
import n8nCommunityNodes from '@n8n/eslint-plugin-community-nodes';
import n8nNodesBase from 'eslint-plugin-n8n-nodes-base';
import parser from '@typescript-eslint/parser';

export default defineConfig(
	{
		// properties.generated.ts is NOT ignored: the scan lints the compiled
		// properties inside the tarball, so linting the generated source keeps the
		// two in step. A violation there is fixed in de-para/, never in the file.
		ignores: ['dist/**', 'node_modules/**'],
	},

	n8nCommunityNodes.configs.recommended,

	{
		rules: { 'no-console': 'error' },
	},

	{ plugins: { 'n8n-nodes-base': n8nNodesBase } },

	{
		files: ['package.json'],
		rules: { ...n8nNodesBase.configs.community.rules },
	},

	{
		files: ['**/credentials/**/*.ts'],
		rules: {
			...n8nNodesBase.configs.credentials.rules,
			// Not valid for community nodes
			'n8n-nodes-base/cred-class-field-documentation-url-miscased': 'off',
			// The community-nodes credential-password-field rule is more accurate
			'n8n-nodes-base/cred-class-field-type-options-password-missing': 'off',
		},
	},

	{
		files: ['**/nodes/**/*.ts'],
		rules: {
			...n8nNodesBase.configs.nodes.rules,
			// Inputs and outputs may be the enum instead of the string "main"
			'n8n-nodes-base/node-class-description-inputs-wrong-regular-node': 'off',
			'n8n-nodes-base/node-class-description-outputs-wrong': 'off',
			// Some third-party APIs do have a maximum, so maxValue is legitimate
			'n8n-nodes-base/node-param-type-options-max-value-present': 'off',
			// properties.generated.ts is emitted from de-para/*.json, which is the
			// source of truth for every label and description.
			'n8n-nodes-base/node-param-description-miscased-json': 'off',
		},
	},

	// JSON files are not parseable by the default JS parser, and the rules that
	// gate on package.json walk a TSESTree ObjectExpression.
	{
		files: ['**/*.json'],
		languageOptions: { parser },
	},

	{
		files: ['**/*.ts'],
		languageOptions: { parser },
	},
);
