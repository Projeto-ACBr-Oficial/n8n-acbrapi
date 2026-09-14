# n8n-nodes-acbrapi

**Official** n8n node for the [ACBr API](https://acbr.api.br), built and maintained by the ACBr team
— Brazilian electronic fiscal documents and business data lookups, driven from your workflows.

The ACBr API puts the whole family of Brazilian fiscal documents behind one account, one credential
and one set of conventions. This node brings them into n8n, starting with **service invoices
(NFS-e)** and the **CNPJ** and **postal code** lookups.

[n8n](https://n8n.io) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow
automation platform.

[What is covered](#what-is-covered) · [Installation](#installation) · [Credentials](#credentials) ·
[Operations](#operations) · [Usage](#usage) · [Example workflow](#example-workflow) ·
[Resources](#resources)

## What is covered

The node is built out one document family at a time. This table is the honest state of it: the
**Resource** list inside the node offers only what is implemented — nothing that is listed and then
throws.

| Document or service | In this node |
| --- | --- |
| **Service invoices — NFS-e** | **Issue · Preview · Get · Get Many · Cancel · Get Cancellation · Sync · Download PDF · Download XML** |
| **CNPJ lookup** | **Get** |
| **Postal code lookup — CEP** | **Get** |
| Companies — registration, A1 certificate, per-service settings | Planned |
| Document trace — what was sent to the city hall and what came back | Planned |
| Product invoices — NF-e | Planned |
| Consumer invoices — NFC-e | Planned |
| NF-e distribution and manifestation | Planned |
| Transport — CT-e and CT-e OS | Planned |
| Transport manifest — MDF-e | Planned |
| Telecom invoices — NFCom | Planned |
| Collection documents — DC-e | Planned |

Everything marked *planned* already exists in the ACBr API and answers to the same account you
configure here — what is missing is the n8n surface for it, not the integration. No dates are
promised; [Roadmap](#roadmap) has the current order of intent, and an issue asking for one of them is
the fastest way to move it up.

## Why this node instead of the HTTP Request node

**The ACBr API token endpoint allows 4 requests per hour.** n8n executions are stateless, so the
obvious pattern — request a token inside the workflow, then call the API — exhausts that limit within
minutes. A workflow running every 5 minutes issues 12 token requests per hour and gets blocked.

This node uses an OAuth2 client-credentials credential, so the token lives in n8n's credential store
and is reused until it expires (about 30 days). The problem disappears without you having to think
about it.

Two more things it handles for you:

- **Duplicate invoices.** The API enforces uniqueness on the external reference. If a request is
  processed but its response is lost, retrying returns HTTP 400. The node recognizes that case and
  returns the invoice that already exists, flagged `alreadyIssued: true`, instead of failing — which
  is what stops you from issuing a second invoice you would then have to cancel.
- **Polling cost.** Checking status with **Get** is free; forcing a re-read with **Sync** costs 1
  credit per call. The node polls with Get.

## Compatibility

- n8n **2.35.4** or later. This is a security floor, not a feature floor: 2.35.4 is the patched
  stable release. Do not run this node against an unpatched n8n.
- Node.js **20.15** or later.
- An ACBr API account with credentials created in the [console](https://console.acbr.api.br).

## Installation

Follow the
[community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

On self-hosted n8n, through the UI: **Settings → Community nodes → Install**, then enter
`@projetoacbr/n8n-nodes-acbrapi`.

## Credentials

The ACBr API authenticates with OAuth 2 `client_credentials`. Create an **ACBr API OAuth2 API**
credential in n8n:

| Field | Notes |
| --- | --- |
| **Environment** | `Staging` (`hom.acbr.api.br`) while developing, `Production` (`prod.acbr.api.br`) for real invoices. Credentials are issued per environment and are **not** interchangeable. |
| **Client ID** / **Client Secret** | Created in the [ACBr API console](https://console.acbr.api.br). |
| **Scopes** | One scope per service. All three are selected by default; uncheck to restrict. A request to an endpoint outside the selected scopes fails with HTTP 403, and the node names the missing scope instead of passing the raw error through. |

You do not configure a token URL or a refresh strategy — the credential fills those in and n8n caches
the token for you.

> **NFS-e in staging often does not work.** Many city halls have no staging environment at all, and
> the API answers `X999: Erro de Conexão: Não informado a URL de Homologação`. The node translates
> that into a readable message. When it happens, the only way to test that city is production.

## One credential, many companies

The ACBr API is built for software houses. Companies are registered **under your tenant**, and a
single credential can act on behalf of all of them — so this node works as the orchestration layer of
a product that issues invoices for N client companies, not just for your own.

That is why **Service Provider Tax ID** is a parameter on the operation and not a credential field:
it selects which company is issuing, per execution. Drive it from your customer table and one
workflow serves every client you have.

Registering a company, uploading its A1 certificate and setting its invoice series are done in the
[console](https://console.acbr.api.br). The certificate stays with the ACBr API and never passes
through n8n.

## Operations

### Service Invoice (NFS-e)

| Operation | What it does | Credits |
| --- | --- | --- |
| **Issue** | Submits a service declaration (DPS) and issues the invoice | 1 per invoice |
| **Preview** | Builds and shows the payload locally. No API call, no credits, no invoice | 0 |
| **Get** | Reads the current status of an invoice | 0 |
| **Get Many** | Lists invoices of a company, optionally filtered by external reference | 0 |
| **Cancel** | Cancels an authorized invoice | 1 |
| **Get Cancellation** | Reads the cancellation event of a cancelled invoice | 0 |
| **Sync** | Forces the city hall to be re-read. Use only when an invoice looks stuck | 1 per call |
| **Download PDF** | Downloads the DANFSE as a binary field | first download free |
| **Download XML** | Downloads the invoice XML as a binary field | first download free |

### CNPJ

**Get** — company registration data for a CNPJ. 0.1 credit.

### Postal Code

**Get** — address for a Brazilian postal code (CEP). 0.1 credit.

## Usage

### Issuing an invoice

Fill in the provider, the customer, the service and the amount, then run **Issue**. The response
carries the invoice `id`, its `status` and, once authorized, a `link_url` to the official invoice
page.

Three things are worth knowing before the first run.

**This node does not calculate tax, and neither does the API.** You send the service amount and the
tax treatment; the city hall or the provider calculates ISS and returns it in the authorized
document. There is no field here for the rate, the tax base or the tax amount — by design. The
authoritative rate lives in the city's own registry.

**The National Service Code (`cTribNac`) is the field people get wrong.** It is 6 digits from the
service list of Complementary Law 116/2003, written without separators — item 14.02.01 becomes
`140201`. There is no lookup endpoint. Find yours in the
[official list](https://www.gov.br/nfse/pt-br/mei-e-demais-empresas/codigos-de-tributacao-nacional-nbs),
or ask your accountant. A wrong code produces a valid invoice taxed the wrong way, which then has to
be cancelled.

If you issue a small set of recurring services, keep the code, the description and the tax treatment
of each one in a table or in a Set node and select by service. Do not let an end user — or an LLM —
choose the code from free text.

**The Environment field must match the credential.** The credential decides which host is called; the
Environment of the operation is written inside the fiscal document. The node refuses the execution if
the two disagree, because a mismatch fails much later, with an obscure message from the city hall.

### Issuing is asynchronous

`Issue` returns as soon as the API accepts the declaration, usually with `status: "processando"`. The
city hall authorizes afterwards, and that can take minutes.

Two ways to follow it:

- **Wait for Authorization** on the Issue operation keeps checking until the invoice is authorized or
  denied, up to **Wait Timeout** seconds. Checking is free, so this costs nothing — but it holds the
  execution open, and a slow city hall holds it for the whole timeout. Good for a manual run or a low
  volume. When the timeout is reached the invoice comes back with `timedOut: true`; it may still be
  authorized later.
- **A second, scheduled workflow** that lists invoices still processing and calls **Get** on each one
  is the production pattern. Nothing is lost if the first execution ends early.

Use **Sync** only when an invoice has been stuck for an unusually long time. It costs 1 credit per
call and re-reads the city hall; it is not a polling mechanism.

### Retries and the external reference

Set **External Reference** to a value your own system already owns and that identifies this billing
event exactly once — an order id, an invoice id, the id of the message that requested it. Then:

- **reuse the same reference on every retry.** Generating a new one on retry is what creates
  duplicate invoices.
- if the invoice was already issued under that reference, the node returns it with
  `alreadyIssued: true` instead of failing, so a retried or re-delivered trigger is harmless.
- **Get Many** accepts the reference as a filter, so you can find an invoice later without storing
  the ACBr id.

The API blocks a repeated reference while the invoice is `processando`, `autorizada` or `cancelada`,
and releases it after a processing error — so a genuine failure can be retried with the same
reference.

### Downloading the PDF and the XML

The first download of each file is free; later downloads of the same file may consume 1 credit.
Store what you download instead of fetching it again. For notifying a customer, prefer the `link_url`
returned on authorization: it is the official page, it is lighter, and it costs nothing.

The ACBr API does not send email for NFS-e. Use your own email node with the PDF or the link.

### Municipality coverage

NFS-e is issued by each city hall, not by a federal authority, so coverage is per city. The ACBr API
reaches **4,688 of 5,571 Brazilian municipalities (84%)** across **102 distinct integration
standards**, behind one normalized payload. Check your city at
<https://acbr.api.br/consulta-nfse/>.

## Example workflow

Issues one invoice in staging and waits up to 3 minutes for the city hall. Copy it and paste into an
n8n canvas, then replace the provider CNPJ, the customer data and the service code with your own.

```json
{
  "name": "ACBr API - issue an NFS-e",
  "nodes": [
    {
      "parameters": {},
      "id": "a1000000-0000-4000-8000-000000000001",
      "name": "Execute Workflow Trigger",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 0]
    },
    {
      "parameters": {
        "resource": "nfse",
        "operation": "create",
        "environment": "homologacao",
        "externalReference": "={{ 'order-' + $execution.id }}",
        "servicePeriod": "={{ $now.toFormat('yyyy-MM-dd') }}T00:00:00",
        "providerCnpj": "00000000000000",
        "customerCnpj": "11111111111111",
        "customerName": "Cliente Exemplo Ltda",
        "customerCityCode": "3550308",
        "customerPostalCode": "01310100",
        "customerStreet": "Avenida Paulista",
        "customerStreetNumber": "1000",
        "customerDistrict": "Bela Vista",
        "nationalServiceCode": "140201",
        "serviceDescription": "Consultoria em tecnologia da informacao",
        "serviceAmount": 1500,
        "serviceTaxTreatment": 1,
        "serviceTaxWithholding": 1,
        "waitForAuthorization": true,
        "waitTimeout": 180
      },
      "id": "a1000000-0000-4000-8000-000000000002",
      "name": "Issue invoice",
      "type": "@projetoacbr/n8n-nodes-acbrapi.acbrApi",
      "typeVersion": 1,
      "position": [220, 0],
      "credentials": {
        "acbrApiOAuth2Api": { "id": "1", "name": "ACBr API account" }
      }
    }
  ],
  "connections": {
    "Execute Workflow Trigger": {
      "main": [[{ "node": "Issue invoice", "type": "main", "index": 0 }]]
    }
  },
  "settings": {}
}
```

Before running it for real, switch **Issue** to **Preview** on the same node: it builds the payload
and shows it without calling the API, spending a credit or creating an invoice.

## Resources

- [ACBr API documentation](https://dev.acbr.api.br/docs)
- [ACBr API console](https://console.acbr.api.br)
- [NFS-e municipality coverage](https://acbr.api.br/consulta-nfse/)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## How this compares to reaching the government directly

The national NFS-e standard can also be reached directly, with an A1 certificate and mTLS from inside
n8n. This node deliberately does not do that:

- it goes through the ACBr API, which normalizes **102 municipal integration standards** behind one
  payload, so a workflow written for one city works for the next one;
- the A1 certificate and its password **never enter n8n** — they stay in the ACBr API, so they are
  not written to the execution database;
- authorization, retries, cancellation events and the document trace are the API's responsibility,
  not the workflow's.

If you only ever issue for cities on the national standard and you are comfortable holding
certificates in your automation platform, a direct integration is a smaller dependency. This one is
for issuing across Brazil without writing a provider adapter per city.

## Development

```bash
npm install
npm run build
cp .env.example .env          # set N8N_ENCRYPTION_KEY
npm run n8n:up                # http://localhost:5678
```

After changing code: `npm run build && npm run n8n:restart`.

`docker-compose.yml` mounts only `package.json` and `dist/` into the container, deliberately —
mounting the project root would expose a host-installed `node_modules` to the Linux container and
break native modules when the host is Windows.

### The properties are generated, not hand-written

`nodes/AcbrApi/properties.generated.ts` is emitted by `npm run gen` from `de-para/*.json`. Those JSON
files are the single source of truth for every label, description, enum and error message, keyed by
the field path in the API payload.

Do not edit the generated file — your change is lost on the next run. Edit the mapping instead.

Three reasons it works this way: the node interface is in English while the API is in Portuguese, so
the mapping has to exist somewhere explicit; a tax specialist can review it without reading
TypeScript; and the same source extends to the other Brazilian fiscal documents, which share the
field semantics.

```bash
npm run gen      # regenerate the properties from the mapping
npm run lint     # the linter n8n verification uses
npm run format
```

## Roadmap

In current order of intent, against the table in [What is covered](#what-is-covered):

1. A searchable picker for the national service code, so it stops being six digits typed by hand.
2. The document trace, which answers *why did the city hall reject this* without leaving n8n.
3. Company registration, certificate upload and per-service settings — the onboarding path for a
   software house adding a client company.
4. The other fiscal documents, starting with NF-e.

Nothing here is dated, and none of it changes the operations already in the node.

## License

[MIT](LICENSE)
