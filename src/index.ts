interface Env {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  WEBHOOK_AUTH_TOKEN: string;
}

interface MatchRequest {
  googleDriveFolderUrl: string;
  date: string;
  address: string;
  addressLine2?: string;
  city: string;
  state?: string;
  zipcode: string | number;
  firstNames: string[];
  lastNames: string[];
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

interface SheetMetadata {
  sheets?: Array<{ properties?: { title?: string } }>;
}

interface ValuesResponse {
  values?: unknown[][];
}

interface BatchValuesResponse {
  valueRanges?: ValuesResponse[];
}

interface MatchResult {
  match: "yes" | "no" | "maybe";
  selection: string | null;
  source: string | null;
}

interface Candidate {
  values: unknown[];
  index: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_SCOPE = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
].join(" ");

let tokenCache: { token: string; expiresAt: number } | undefined;

const HEADER_ALIASES = {
  state: ["state", "statabbr", "stateabbr", "stateabbrev"],
  city: ["city", "cityplac", "cityplace"],
  zip: ["recdzipc", "zipcode", "zip", "postalcode", "zip5"],
  address: ["address", "addressline1", "address1line", "address1", "addr", "streetaddress"],
  address2: ["address2line", "addressline2", "address2", "addr2", "apartment", "unit", "suite"],
  lastName: ["lastname", "snamsnam", "surname", "lname", "last"],
  firstName: ["firstname", "fnamfnam", "givenname", "fname", "first"],
} as const;

const ROAD_TYPES: Record<string, string> = {
  aly: "alley", alley: "alley", ave: "avenue", av: "avenue", avenue: "avenue",
  blvd: "boulevard", boulevard: "boulevard", cir: "circle", circle: "circle",
  ct: "court", court: "court", dr: "drive", drive: "drive", hwy: "highway",
  highway: "highway", ln: "lane", lane: "lane", pkwy: "parkway", parkway: "parkway",
  pl: "place", place: "place", rd: "road", road: "road", sq: "square", square: "square",
  st: "street", street: "street", ter: "terrace", terrace: "terrace", trl: "trail",
  trail: "trail", way: "way", loop: "loop", plz: "plaza", plaza: "plaza",
  cv: "cove", cove: "cove", pike: "pike", rte: "route", route: "route",
};

const DIRECTIONS: Record<string, string> = {
  n: "north", north: "north", s: "south", south: "south", e: "east", east: "east",
  w: "west", west: "west", ne: "northeast", northeast: "northeast",
  nw: "northwest", northwest: "northwest", se: "southeast", southeast: "southeast",
  sw: "southwest", southwest: "southwest",
};

const ORDINALS: Record<string, string> = {
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6",
  seventh: "7", eighth: "8", ninth: "9", tenth: "10", eleventh: "11", twelfth: "12",
  thirteenth: "13", fourteenth: "14", fifteenth: "15", sixteenth: "16",
  seventeenth: "17", eighteenth: "18", nineteenth: "19", twentieth: "20",
};

const STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia", kansas: "ks",
  kentucky: "ky", louisiana: "la", maine: "me", maryland: "md", massachusetts: "ma",
  michigan: "mi", minnesota: "mn", mississippi: "ms", missouri: "mo", montana: "mt",
  nebraska: "ne", nevada: "nv", newhampshire: "nh", newjersey: "nj", newmexico: "nm",
  newyork: "ny", northcarolina: "nc", northdakota: "nd", ohio: "oh", oklahoma: "ok",
  oregon: "or", pennsylvania: "pa", rhodeisland: "ri", southcarolina: "sc",
  southdakota: "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", westvirginia: "wv", wisconsin: "wi", wyoming: "wy",
  districtofcolumbia: "dc", washingtondc: "dc", puertorico: "pr",
};

// Mailing-city aliases must be scoped to a ZIP code. Do not add a city pair
// globally: municipal names can overlap in unrelated places.
const CITY_ZIP_ALIASES: Record<string, readonly (readonly string[])[]> = {
  "90046": [["los angeles", "west hollywood"]],
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (!env.WEBHOOK_AUTH_TOKEN) return errorJson("Webhook bearer token is not configured.", 500);
    if (request.headers.get("authorization") !== `Bearer ${env.WEBHOOK_AUTH_TOKEN}`) {
      console.warn("[mailer-check] Unauthorized request", JSON.stringify({
        method: request.method,
        hasAuthorizationHeader: Boolean(request.headers.get("authorization")),
      }));
      return errorJson("Unauthorized.", 401);
    }
    if (request.method !== "POST") return errorJson("Use POST /match.", 405);

    try {
      const url = new URL(request.url);
      if (url.pathname !== "/match") throw new HttpError(404, "Endpoint not found. Use POST /match.");
      const input = validateQuery(url.searchParams);
      console.log("[mailer-check] Extracted match input", JSON.stringify({
        googleDriveFolderUrl: input.googleDriveFolderUrl,
        date: input.date,
        address: input.address,
        addressLine2: input.addressLine2,
        city: input.city,
        state: input.state,
        zipcode: input.zipcode,
        firstNames: input.firstNames,
        lastNames: input.lastNames,
      }));
      const result = await findMatchingRow(input, env);
      console.log("[mailer-check] Match result", JSON.stringify({
        match: result.match,
        source: result.source,
        selected: result.selection !== null,
      }));
      return json(result);
    } catch (error) {
      if (error instanceof HttpError) {
        console.warn("[mailer-check] Request failed", JSON.stringify({ status: error.status, error: error.message }));
        return errorJson(error.message, error.status);
      }
      console.error(error);
      return errorJson("Unexpected server error.", 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function findMatchingRow(input: MatchRequest, env: Env): Promise<MatchResult> {
  const accessToken = await getAccessToken(env);
  const rootFolderId = parseDriveFolderId(input.googleDriveFolderUrl);
  const { quarter, month, day } = parseDate(input.date);
  const quarterFolder = await findSingleDriveFile(
    accessToken,
    `'${escapeDriveQuery(rootFolderId)}' in parents and mimeType = '${GOOGLE_FOLDER_MIME}' and name = '${quarter}' and trashed = false`,
    `Quarter folder ${quarter} was not found in the supplied Drive folder.`,
  );
  const quarterFiles = await listDriveFiles(
    accessToken,
    `'${escapeDriveQuery(quarterFolder.id)}' in parents and trashed = false`,
  );
  const matchingSheets = quarterFiles.filter((file) =>
    file.mimeType === GOOGLE_SHEET_MIME && sheetNameMatchesDate(file.name, month, day),
  );
  if (matchingSheets.length === 0) {
    throw new HttpError(404, `No native Google Sheet for ${input.date} was found in ${quarter}.`);
  }
  if (matchingSheets.length > 1) {
    throw new HttpError(409, `More than one native Google Sheet matches ${input.date} in ${quarter}: ${matchingSheets.map((file) => file.name).join(", ")}.`);
  }
  return findRowInSpreadsheet(accessToken, matchingSheets[0].id, input);
}

async function findRowInSpreadsheet(token: string, spreadsheetId: string, input: MatchRequest): Promise<MatchResult> {
  const metadata = await googleGet<SheetMetadata>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`, token,
  );
  const sheetTitles = metadata.sheets?.map((sheet) => sheet.properties?.title).filter((title): title is string => Boolean(title)) ?? [];
  let foundSearchableSheet = false;
  let nameOnlyMatch: { title: string; headers: unknown[]; candidate: Candidate } | undefined;
  for (const title of sheetTitles) {
    const header = await googleGet<ValuesResponse>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${title}!1:1`)}`,
      token,
    );
    const headers = header.values?.[0] ?? [];
    if (headers.length === 0) continue;
    const columns = getColumns(headers);
    const canSearchAddress = columns.address !== undefined
      && columns.city !== undefined
      && columns.zip !== undefined
      && (!input.state || columns.state !== undefined);
    const canSearchNames = columns.firstName !== undefined && columns.lastName !== undefined;
    if (!canSearchAddress && !canSearchNames) continue;
    const candidates = await findCandidatesInSheet(token, spreadsheetId, title, headers, columns);

    if (canSearchAddress) {
      foundSearchableSheet = true;
      const addressCandidates = candidates.filter(({ values }) => rowMatchesAddress(values, columns, input));
      const decision = selectAddressCandidate(addressCandidates, columns, input);
      if (decision) return selectedResult(token, spreadsheetId, title, headers, decision.candidate, decision.match);
    }
    if (!nameOnlyMatch && canSearchNames) {
      const candidate = candidates.find(({ values }) => rowMatchesNameCombination(values, columns, input));
      if (candidate) nameOnlyMatch = { title, headers, candidate };
    }
  }
  if (nameOnlyMatch) {
    return selectedResult(token, spreadsheetId, nameOnlyMatch.title, nameOnlyMatch.headers, nameOnlyMatch.candidate, "maybe");
  }
  if (!foundSearchableSheet) {
    throw new HttpError(422, "No worksheet contains recognizable address, city, state, and ZIP headers.");
  }
  return { match: "no", selection: null, source: null };
}

async function selectedResult(
  token: string,
  spreadsheetId: string,
  title: string,
  headers: unknown[],
  candidate: Candidate,
  match: "yes" | "maybe",
): Promise<MatchResult> {
  const row = await googleGet<ValuesResponse>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${title}!${candidate.index}:${candidate.index}`)}`,
    token,
  );
  return { match, selection: rowToText(headers, row.values?.[0] ?? candidate.values), source: title };
}

async function findCandidatesInSheet(
  token: string,
  spreadsheetId: string,
  title: string,
  headers: unknown[],
  columns: Record<string, number | undefined>,
): Promise<Candidate[]> {
  const neededColumns = [...new Set(Object.values(columns).filter((column): column is number => column !== undefined))];
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`);
  for (const column of neededColumns) url.searchParams.append("ranges", columnRange(title, column));
  const data = await googleGet<BatchValuesResponse>(url.toString(), token);
  const ranges = data.valueRanges ?? [];
  const rowCount = Math.max(0, ...ranges.map((range) => range.values?.length ?? 0));
  const candidates: Candidate[] = [];
  for (let rowIndex = 1; rowIndex < rowCount; rowIndex += 1) {
    const values: unknown[] = Array(headers.length).fill("");
    neededColumns.forEach((column, rangeIndex) => {
      values[column] = ranges[rangeIndex]?.values?.[rowIndex]?.[0] ?? "";
    });
    candidates.push({ values, index: rowIndex + 1 });
  }
  return candidates;
}

function selectAddressCandidate(
  candidates: Candidate[],
  columns: Record<string, number | undefined>,
  input: MatchRequest,
): { candidate: Candidate; match: "yes" | "maybe" } | null {
  if (candidates.length === 0) return null;
  const lastNameMatches = candidates.filter(({ values }) => nameMatches(valueAt(values, columns.lastName), input.lastNames));
  const firstNameMatches = candidates.filter(({ values }) => nameMatches(valueAt(values, columns.firstName), input.firstNames));
  if (lastNameMatches.length > 0) {
    const bothNameMatches = lastNameMatches.filter(({ values }) => nameMatches(valueAt(values, columns.firstName), input.firstNames));
    return { candidate: bothNameMatches[0] ?? lastNameMatches[0], match: "yes" };
  }
  if (firstNameMatches.length > 0) return { candidate: firstNameMatches[0], match: "yes" };
  return { candidate: candidates[0], match: "maybe" };
}

function rowMatchesNameCombination(values: unknown[], columns: Record<string, number | undefined>, input: MatchRequest): boolean {
  return nameMatches(valueAt(values, columns.firstName), input.firstNames)
    && nameMatches(valueAt(values, columns.lastName), input.lastNames);
}

function rowMatchesAddress(values: unknown[], columns: Record<string, number | undefined>, input: MatchRequest): boolean {
  // A second address field represents a unit/designator and is intentionally not
  // required: the same recipient may be supplied/stored with or without it.
  return addressEquals(
    input.address,
    valueAt(values, columns.address),
  )
    && cityMatches(input.city, valueAt(values, columns.city), normalizeZip(input.zipcode))
    && (!input.state || normalizeState(input.state) === normalizeState(valueAt(values, columns.state)))
    && normalizeZip(input.zipcode) === normalizeZip(valueAt(values, columns.zip));
}

function getColumns(headers: unknown[]): Record<string, number | undefined> {
  const result: Record<string, number | undefined> = {};
  for (const [kind, aliases] of Object.entries(HEADER_ALIASES)) {
    result[kind] = headers.findIndex((header) => aliases.includes(normalizeHeader(header) as never));
    if (result[kind] === -1) result[kind] = undefined;
  }
  return result;
}

function rowToText(headers: unknown[], values: unknown[]): string {
  const usedKeys = new Set<string>();
  const lines: string[] = [];
  headers.forEach((header, index) => {
    const preferredKey = String(header ?? "").trim() || `column_${index + 1}`;
    let key = preferredKey;
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${preferredKey}_${suffix}`;
      suffix += 1;
    }
    usedKeys.add(key);
    lines.push(`${key}: ${String(values[index] ?? "")}`);
  });
  return lines.join("\n");
}

function validateQuery(query: URLSearchParams): MatchRequest {
  const candidate = {
    googleDriveFolderUrl: query.get("googleDriveFolderUrl"),
    date: query.get("date"),
    address: query.get("address"),
    addressLine2: query.get("addressLine2"),
    city: query.get("city"),
    state: query.get("state"),
    zipcode: query.get("zipcode"),
    firstName: query.getAll("firstName"),
    lastName: query.getAll("lastName"),
  };
  const required = ["googleDriveFolderUrl", "date", "address", "city", "zipcode"] as const;
  for (const field of required) {
    if (candidate[field] === undefined || candidate[field] === null || String(candidate[field]).trim() === "") {
      throw new HttpError(400, `Missing required field: ${field}.`);
    }
  }
  return {
    googleDriveFolderUrl: String(candidate.googleDriveFolderUrl).trim(), date: String(candidate.date).trim(),
    address: String(candidate.address).trim(), addressLine2: candidate.addressLine2?.trim() || undefined,
    city: String(candidate.city).trim(), state: candidate.state?.trim() || undefined,
    zipcode: String(candidate.zipcode).trim(),
    firstNames: parseNameList(candidate.firstName, "firstName"), lastNames: parseNameList(candidate.lastName, "lastName"),
  };
}

function parseNameList(value: unknown, field: "firstName" | "lastName"): string[] {
  const rawNames = Array.isArray(value) ? value : [value];
  if (rawNames.some((name) => typeof name !== "string")) throw new HttpError(400, `${field} must be a string or an array of strings.`);
  const names = rawNames.flatMap((name) => name.split(/[;,]/)).map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) throw new HttpError(400, `Missing required field: ${field}.`);
  return names;
}

function parseDate(input: string): { quarter: string; month: number; day: number } {
  const usDate = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(\d{4})$/.exec(input);
  const isoDate = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(input);
  if (!usDate && !isoDate) throw new HttpError(400, "date or seminar_date must use MM/DD/YYYY or YYYY-MM-DD format.");
  const month = Number(usDate?.[1] ?? isoDate?.[2]);
  const day = Number(usDate?.[2] ?? isoDate?.[3]);
  const year = Number(usDate?.[3] ?? isoDate?.[1]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new HttpError(400, "date is not a real calendar date.");
  }
  return { quarter: `Q${Math.ceil(month / 3)}`, month, day };
}

function sheetNameMatchesDate(name: string, month: number, day: number): boolean {
  const monthPatterns = [
    "jan(?:uary)?", "feb(?:ruary)?", "mar(?:ch)?", "apr(?:il)?", "may",
    "jun(?:e)?", "jul(?:y)?", "aug(?:ust)?", "sep(?:tember)?", "oct(?:ober)?",
    "nov(?:ember)?", "dec(?:ember)?",
  ];
  // Month and day are independently located. This supports multi-day names
  // such as "Aug 17&18 Mailing List" for either August 17 or August 18.
  const hasMonth = new RegExp(`(?:^|[^a-z])${monthPatterns[month - 1]}(?=$|[^a-z])`, "i").test(name);
  const hasDay = new RegExp(`(?:^|[^0-9])0?${day}(?=$|[^0-9])`).test(name);
  return hasMonth && hasDay;
}

function parseDriveFolderId(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/drive\.google\.com$/i.test(parsed.hostname)) throw new Error();
    const match = /\/folders\/([a-zA-Z0-9_-]+)/.exec(parsed.pathname);
    if (!match) throw new Error();
    return match[1];
  } catch {
    throw new HttpError(400, "googleDriveFolderUrl must be a Google Drive folder URL.");
  }
}

async function findSingleDriveFile(token: string, query: string, notFoundMessage: string): Promise<DriveFile> {
  const files = await listDriveFiles(token, query);
  if (files.length === 0) throw new HttpError(404, notFoundMessage);
  if (files.length > 1) throw new HttpError(409, `More than one Drive item matches: ${files.map((file) => file.name).join(", ")}.`);
  return files[0];
}

async function listDriveFiles(token: string, query: string): Promise<DriveFile[]> {
  const fields = "nextPageToken,files(id,name,mimeType)";
  let pageToken: string | undefined;
  const files: DriveFile[] = [];
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", query);
    url.searchParams.set("fields", fields);
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleGet<{ files?: DriveFile[]; nextPageToken?: string }>(url.toString(), token);
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

async function getAccessToken(env: Env): Promise<string> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
    throw new HttpError(500, "Google service-account credentials are not configured.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt > now + 60) return tokenCache.token;
  const assertion = await createServiceAccountJwt(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, now);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const data = await response.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !data.access_token) throw new HttpError(502, `Google authentication failed: ${data.error_description ?? response.statusText}`);
  tokenCache = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) };
  return tokenCache.token;
}

async function createServiceAccountJwt(email: string, privateKey: string, issuedAt: number): Promise<string> {
  const encode = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: email, scope: GOOGLE_SCOPE, aud: "https://oauth2.googleapis.com/token", iat: issuedAt, exp: issuedAt + 3600 })}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function googleGet<T>(url: string, token: string): Promise<T> {
  return googleRequest<T>(url, token);
}

async function googleRequest<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const message = await response.text();
    throw new HttpError(502, `Google API request failed (${response.status}): ${message.slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

function columnRange(sheetTitle: string, zeroBasedColumn: number): string {
  let number = zeroBasedColumn + 1;
  let letters = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    number = Math.floor((number - 1) / 26);
  }
  return `'${sheetTitle.replace(/'/g, "''")}'!${letters}:${letters}`;
}

function addressEquals(left: string, right: string): boolean {
  const leftVariants = addressVariants(left);
  const rightVariants = addressVariants(right);
  return [...leftVariants].some((variant) => rightVariants.has(variant));
}

function addressVariants(value: string): Set<string> {
  let normalized = normalizeText(value).replace(/\bp\s+o\b/g, "po");
  const poBox = /^po\s*(?:box|b)\s*(?:number|num|unit)?\s*(\d+[a-z0-9-]*)$/.exec(normalized);
  if (poBox) return new Set([`po box ${poBox[1]}`]);

  normalized = normalized.replace(/\b(?:apartment|apt|unit|suite|ste|floor|fl)\s*(?:number|num)?\s*[a-z0-9-]+\b/g, " ");
  const tokens = normalized.split(" ").filter(Boolean).map((token) => {
    if (/^\d+(?:st|nd|rd|th)$/.test(token)) return token.replace(/(?:st|nd|rd|th)$/, "");
    return ORDINALS[token] ?? DIRECTIONS[token] ?? ROAD_TYPES[token] ?? token;
  });
  const full = tokens.join(" ");
  const variants = new Set([full]);
  if (tokens.length > 2 && Object.values(ROAD_TYPES).includes(tokens.at(-1) ?? "")) {
    variants.add(tokens.slice(0, -1).join(" "));
  }
  return variants;
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, " and ").replace(/#/g, " unit ")
    .replace(/[^a-z0-9/]+/g, " ").trim().replace(/\s+/g, " ");
}

function normalizeHeader(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, "").replace(/_/g, "");
}

function normalizeState(value: unknown): string {
  const normalized = normalizeText(value).replace(/\s+/g, "");
  return STATE_ABBREVIATIONS[normalized] ?? normalized;
}

function cityMatches(left: unknown, right: unknown, zip: string): boolean {
  const leftCity = normalizeText(left);
  const rightCity = normalizeText(right);
  if (leftCity === rightCity) return true;
  return (CITY_ZIP_ALIASES[zip] ?? []).some((cities) => cities.includes(leftCity) && cities.includes(rightCity));
}

function normalizeZip(value: unknown): string {
  const match = String(value ?? "").match(/\d{5}/);
  return match?.[0] ?? "";
}

function nameMatches(value: unknown, inputNames: string[]): boolean {
  const normalizedValue = normalizePersonName(value);
  return normalizedValue !== "" && inputNames.some((name) => normalizedValue === normalizePersonName(name));
}

function normalizePersonName(value: unknown): string {
  let normalized = normalizeText(value);
  // A suffix identifies a generation or credential, not the surname itself.
  // Remove only trailing suffixes so a legitimate name token elsewhere remains.
  const suffix = /\s+(?:jr|junior|sr|senior|ii|iii|iv|v|vi|esq|esquire|md|phd|dds|do|od|ret)$/;
  while (suffix.test(normalized)) normalized = normalized.replace(suffix, "");
  return normalized.replace(/\s+/g, "");
}

function valueAt(values: unknown[], index: number | undefined): string {
  return index === undefined ? "" : String(values[index] ?? "").trim();
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const encoded = pem.replace(/\\n/g, "\n").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  return new Response(response.body, { status: response.status, headers });
}

function json(body: unknown, status = 200): Response {
  return cors(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } }));
}

function errorJson(error: string, status: number): Response {
  return json({ match: "no", selection: null, source: null, error }, status);
}
