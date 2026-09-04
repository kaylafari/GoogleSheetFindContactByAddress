# Mailer Check

A Cloudflare Worker that finds a dated Google Sheet in a Drive quarter folder and returns the one matching recipient row.

## Endpoint

`POST /match` with every matching input in the query string. The request body is ignored.

```text
POST /match?googleDriveFolderUrl=https%3A%2F%2Fdrive.google.com%2Fdrive%2Ffolders%2FROOT_FOLDER_ID&date=10%2F20%2F2026&address=1234%20W%20Ninth%20Ave&addressLine2=Apt%203B&city=Example%20City&state=California&zipcode=90210&firstName=Jane&lastName=Doe
```

Required query parameters are `googleDriveFolderUrl`, `date`, `address`, `city`, `zipcode`, `firstName`, and `lastName`. `addressLine2` and `state` are optional. When `state` is supplied, it is used as an additional match constraint. To supply multiple name variants, repeat `firstName` or `lastName` (for example, `&firstName=Jane&firstName=Janet`).

Responses use `"yes"`, `"no"`, or `"maybe"` for `match`:

```json
{ "match": "yes", "selection": "First Name: Jane\nLast Name: Doe", "source": "Los Angeles" }
```

or:

```json
{ "match": "no", "selection": null, "source": null }
```

`"yes"` means an address match has at least one matching supplied name. `"maybe"` means either an address match has no matching supplied name, or no address matched but a supplied first/last-name combination did. `"no"` means neither search found a row. `selection` is a single string with one `key: value` pair per line for the selected row; it is `null` when no row is selected. `source` is the worksheet/tab (table) name where the selected row was found, or `null` when no row is selected. Failures use an error status with `match: "no"`, `selection: null`, and `{ "error": "..." }`: `404` for a missing quarter folder or dated sheet, `409` for ambiguous Drive matches, and `422` when no sheet has the required address headers.

## Google setup

1. Enable the Google Drive API and Google Sheets API in the service account's Google Cloud project.
2. Give the service-account email access to the root Drive folder (and inherited access to the `Q1`–`Q4` folders).
3. Copy `.dev.vars.example` to `.dev.vars` and add the service-account values for local work. Do not commit `.dev.vars`.
4. For deployment, upload both values as Cloudflare secrets:

```sh
npx wrangler secret bulk .dev.vars
```

## Run and deploy

```sh
npm install
npm run dev
npm run deploy
```

The Worker uses REST calls and Web Crypto directly, so it does not depend on Node-only Google SDK packages.

## HighLevel Workflow Webhook

Set the Workflow **Webhook** action to `POST` to the endpoint and add the contact merge fields as query parameters in the URL. The Worker does not read webhook JSON/body data.

| HighLevel field | Query parameter |
|---|---|
| `first_name` | `firstName` |
| `last_name` | `lastName` |
| `address1` | `address` |
| `address2` (if present) | `addressLine2` |
| `city` | `city` |
| `state` | `state` |
| `postal_code` | `zipcode` |
| `Seminar Date` custom field | `date` |

Include `googleDriveFolderUrl` as a query parameter with the Google Drive root-folder URL. URL-encode every value when building the URL. The Seminar Date custom field can be `MM/DD/YYYY` or HighLevel's common `YYYY-MM-DD` format.

Add this header to the Workflow Webhook configuration:

```text
Authorization: Bearer YOUR_WEBHOOK_AUTH_TOKEN
```

Store the token locally in `.dev.vars` as `WEBHOOK_AUTH_TOKEN`, and in Cloudflare as a Worker secret. Requests without the exact bearer token receive HTTP `401`.

### Temporary webhook debugging

The deployed Worker currently logs extracted query values and request outcomes to Cloudflare Tail. These logs contain contact data and should be removed after debugging. Run:

```sh
npm exec -- wrangler tail mailer-check --format pretty
```

Example URL shape (values shown URL-encoded):

```text
https://YOUR_WORKER_URL/match?googleDriveFolderUrl=https%3A%2F%2Fdrive.google.com%2Fdrive%2Ffolders%2FROOT_FOLDER_ID&date=2026-08-18&address=1763%20S%20Crescent%20Heights%20Boulevard&city=Los%20Angeles&state=CA&zipcode=90035-4614&firstName=Evangeline&lastName=Galicia
```

## Matching behavior

- Dates determine the exact folder `Q1`, `Q2`, `Q3`, or `Q4`.
- Spreadsheet names match a full or abbreviated month and the requested day independently, case-insensitively. This supports compact names such as `October20` and multi-day names such as `Aug 17&18 Mailing List` for either August 17 or August 18.
- Only native Google Sheets are considered. Other Drive files, including `.xlsx` workbooks, are ignored.
- All worksheet tabs are searched in their spreadsheet order. The Worker first retrieves only the header and identity columns required for matching, then retrieves the full row only for a selected result.
- Address matching handles casing, punctuation, address-line 2/unit variants, street directions, common street-type abbreviations or omission, ordinal forms such as `Ninth` / `9th`, fractions, PO Boxes, full/abbreviated states, and ZIP+4.
- Name matching ignores common trailing suffixes such as `Jr`, `Sr`, `II`–`VI`, `Esq`, `MD`, and `PhD`; the original source value remains unchanged in `selection`.
- City matching is strict by default. A small ZIP-scoped city-alias map supports approved mailing-city variants (currently `Los Angeles` / `West Hollywood` within ZIP `90046`) without treating those cities as equivalent elsewhere.
- Address matches prefer a row with a matching last name, then first name. If an address matches but neither supplied name does, the first matching row is selected with `match: "maybe"`. When no address matches, the Worker searches all worksheet tabs for the supplied first/last-name combinations and returns the first result with `match: "maybe"`.
