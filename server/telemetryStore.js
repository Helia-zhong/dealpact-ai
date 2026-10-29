const SECRET_KEY = /authorization|cookie|secret|password|access.?token|refresh.?token|api.?key/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, SECRET_KEY.test(key) ? '[REDACTED]' : redact(item),
    ]));
  }
  return value;
}

function collectLinks(value) {
  if (!value || typeof value !== 'object') return [];
  const links = Array.isArray(value.links) ? [...value.links] : [];
  if (value.href && value.rel) links.push({ href: value.href, rel: value.rel, method: value.method });
  return [...links, ...Object.entries(value)
    .filter(([key]) => key !== 'links')
    .flatMap(([, child]) => collectLinks(child))];
}

export class TelemetryStore {
  constructor(capacity = 500) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Telemetry capacity must be positive.');
    this.capacity = capacity;
    this.entries = new Array(capacity);
    this.sequence = 0;
    this.size = 0;
  }

  record(entry) {
    const safe = redact(structuredClone(entry));
    const record = {
      ...safe, id: ++this.sequence, timestamp: new Date().toISOString(),
      source: safe.source ?? 'PAYPAL', latencyMs: Math.max(0, Math.round(safe.latencyMs ?? 0)),
      status: safe.response?.status ?? safe.status ?? 200,
      debugId: safe.response?.headers?.['paypal-debug-id'] ?? safe.debugId ?? null,
      links: collectLinks(safe.response?.body),
    };
    this.entries[(record.id - 1) % this.capacity] = record;
    this.size = Math.min(this.size + 1, this.capacity);
    return structuredClone(record);
  }

  list({ after = 0, limit = 100, source } = {}) {
    const records = [];
    for (let id = Math.max(this.sequence - this.size + 1, after + 1); id <= this.sequence; id++) {
      const entry = this.entries[(id - 1) % this.capacity];
      if (!source || entry.source === source) records.push(entry);
    }
    return structuredClone(records.slice(-Math.min(limit, this.capacity)));
  }

  snapshot(options) {
    return { entries: this.list(options), cursor: this.sequence, retained: this.size, capacity: this.capacity };
  }
}
