const BASE_URL = 'https://api.airtable.com/v0';

function getConfig() {
  const pat = process.env.AIRTABLE_PAT;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!pat || !baseId) {
    throw new Error('Missing AIRTABLE_PAT or AIRTABLE_BASE_ID environment variables');
  }
  return { pat, baseId };
}

function headers() {
  const { pat } = getConfig();
  return {
    Authorization: `Bearer ${pat}`,
    'Content-Type': 'application/json',
  };
}

function tableUrl(table: string) {
  const { baseId } = getConfig();
  return `${BASE_URL}/${baseId}/${encodeURIComponent(table)}`;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime: string;
}

interface AirtableListResponse {
  records: AirtableRecord[];
  offset?: string;
}

export async function createRecord(
  table: string,
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  const res = await fetch(tableUrl(table), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable createRecord failed (${res.status}): ${body}`);
  }
  return res.json();
}

export async function getRecord(
  table: string,
  id: string,
): Promise<AirtableRecord> {
  const res = await fetch(`${tableUrl(table)}/${id}`, {
    method: 'GET',
    headers: headers(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable getRecord failed (${res.status}): ${body}`);
  }
  return res.json();
}

export async function getRecords(
  table: string,
  options?: {
    filterByFormula?: string;
    sort?: Array<{ field: string; direction?: 'asc' | 'desc' }>;
    maxRecords?: number;
  },
): Promise<AirtableRecord[]> {
  const all: AirtableRecord[] = [];
  let offset: string | undefined;

  do {
    const params = new URLSearchParams();
    if (options?.filterByFormula) {
      params.set('filterByFormula', options.filterByFormula);
    }
    if (options?.sort) {
      options.sort.forEach((s, i) => {
        params.set(`sort[${i}][field]`, s.field);
        if (s.direction) {
          params.set(`sort[${i}][direction]`, s.direction);
        }
      });
    }
    if (options?.maxRecords) {
      params.set('maxRecords', String(options.maxRecords));
    }
    if (offset) {
      params.set('offset', offset);
    }

    const url = `${tableUrl(table)}?${params.toString()}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: headers(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable getRecords failed (${res.status}): ${body}`);
    }

    const data: AirtableListResponse = await res.json();
    all.push(...data.records);
    offset = data.offset;
  } while (offset);

  return all;
}

export async function updateRecord(
  table: string,
  id: string,
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  const res = await fetch(`${tableUrl(table)}/${id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable updateRecord failed (${res.status}): ${body}`);
  }
  return res.json();
}

export async function batchCreateRecords(
  table: string,
  records: Array<{ fields: Record<string, unknown> }>,
): Promise<AirtableRecord[]> {
  const all: AirtableRecord[] = [];

  // Airtable allows max 10 records per batch request
  for (let i = 0; i < records.length; i += 10) {
    const chunk = records.slice(i, i + 10);
    const res = await fetch(tableUrl(table), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ records: chunk }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable batchCreateRecords failed (${res.status}): ${body}`);
    }
    const data: { records: AirtableRecord[] } = await res.json();
    all.push(...data.records);
  }

  return all;
}
