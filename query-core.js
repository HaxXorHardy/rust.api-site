/**
 * Gemeinsame Query-Logik fuer Client und Worker.
 *
 * Beide beantworten dieselben Parameter mit identischer Semantik: Filter,
 * Sortierung, Pagination, Feldauswahl und ETag.
 */

export const LIMITS = Object.freeze({
  defaultPerPage: 25,
  maxPerPage: 200,
  maxFields: 50,
  maxQueryLength: 200,
});

export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Boolean aus Query-String (`true/1/yes` bzw. `false/0/no`). */
export function parseBoolean(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const text = String(value).toLowerCase();
  if (['true', '1', 'yes', 'ja'].includes(text)) {
    return true;
  }
  if (['false', '0', 'no', 'nein'].includes(text)) {
    return false;
  }
  return undefined;
}

/** Ganzzahl mit Grenzen; `undefined` bei ungueltiger Eingabe. */
export function parseInteger(value, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number) || number < min || number > max) {
    return undefined;
  }
  return number;
}

/**
 * Liest erlaubte Parameter aus `URLSearchParams`.
 * @param {URLSearchParams} params
 * @param {Record<string, 'string'|'boolean'|'int'>} spec
 */
export function readQuery(params, spec) {
  const options = {};
  const errors = [];
  for (const [key, type] of Object.entries(spec)) {
    const raw = params.get(key);
    if (raw === null || raw === '') {
      continue;
    }
    if (type === 'string') {
      if (raw.length > LIMITS.maxQueryLength) {
        errors.push(`${key} ist zu lang (max. ${LIMITS.maxQueryLength} Zeichen)`);
        continue;
      }
      options[key] = raw;
    } else if (type === 'boolean') {
      const value = parseBoolean(raw);
      if (value === undefined) {
        errors.push(`${key} muss true oder false sein`);
      } else {
        options[key] = value;
      }
    } else if (type === 'int') {
      const value = parseInteger(raw);
      if (value === undefined) {
        errors.push(`${key} muss eine Ganzzahl sein`);
      } else {
        options[key] = value;
      }
    }
  }
  const page = parseInteger(params.get('page'), { min: 1 });
  const perPage = parseInteger(params.get('perPage'), { min: 1, max: LIMITS.maxPerPage });
  if (params.get('page') !== null && page === undefined) {
    errors.push('page muss eine Ganzzahl >= 1 sein');
  }
  if (params.get('perPage') !== null && perPage === undefined) {
    errors.push(`perPage muss zwischen 1 und ${LIMITS.maxPerPage} liegen`);
  }
  options.page = page || 1;
  options.perPage = perPage || LIMITS.defaultPerPage;
  const fields = params.get('fields');
  if (fields) {
    const paths = fields.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (paths.length > LIMITS.maxFields) {
      errors.push(`fields erlaubt maximal ${LIMITS.maxFields} Pfade`);
    } else {
      options.fields = paths;
    }
  }
  return { options, errors };
}

/** Filtert Item-Summaries (identisch in Client und Worker). */
export function filterItems(items, query) {
  const tokens = normalizeText(query.q).trim().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (query.category && normalizeText(item.category) !== normalizeText(query.category)) {
      return false;
    }
    if (query.craftable !== undefined && item.craftable !== query.craftable) {
      return false;
    }
    if (query.recyclable !== undefined && item.recyclable !== query.recyclable) {
      return false;
    }
    if (query.deployable !== undefined && item.deployable !== query.deployable) {
      return false;
    }
    if (query.hasSkins !== undefined && item.hasSkins !== query.hasSkins) {
      return false;
    }
    if (query.minStackSize !== undefined && (item.stackSize ?? 0) < query.minStackSize) {
      return false;
    }
    if (query.maxStackSize !== undefined && (item.stackSize ?? 0) > query.maxStackSize) {
      return false;
    }
    if (tokens.length > 0) {
      const haystack = normalizeText(
        `${item.name} ${item.slug} ${item.id} ${item.shortName} ${item.category}`,
      );
      if (!tokens.every((token) => haystack.includes(token))) {
        return false;
      }
    }
    return true;
  });
}

const SORT_KEYS = {
  name: (item) => normalizeText(item.name),
  slug: (item) => normalizeText(item.slug),
  category: (item) => normalizeText(item.category),
  stackSize: (item) => item.stackSize ?? 0,
};

/** Sortiert nach erlaubten Schluesseln, stabil und ohne `Intl`. */
export function sortItems(items, sort = 'name', order = 'asc') {
  const key = SORT_KEYS[sort] || SORT_KEYS.name;
  const direction = order === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left === right) {
      return normalizeText(a.slug) < normalizeText(b.slug) ? -1 : 1;
    }
    return left < right ? -direction : direction;
  });
}

/** Schneidet eine Seite heraus und liefert Metadaten. */
export function paginate(items, page = 1, perPage = LIMITS.defaultPerPage) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * perPage;
  return {
    rows: items.slice(start, start + perPage),
    pagination: {
      page: current,
      perPage,
      total,
      pages,
      next: current < pages ? current + 1 : null,
      prev: current > 1 ? current - 1 : null,
    },
  };
}

/** Feldauswahl mit Punktpfaden (`craft.cost`); unbekannte Pfade entfallen. */
export function projectFields(value, fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return value;
  }
  const out = {};
  for (const path of fields) {
    const parts = String(path).split('.').filter(Boolean);
    let source = value;
    let target = out;
    let ok = true;
    for (let index = 0; index < parts.length; index += 1) {
      const key = parts[index];
      if (source === undefined || source === null || !(key in source)) {
        ok = false;
        break;
      }
      if (index === parts.length - 1) {
        target[key] = source[key];
      } else {
        target[key] = target[key] || {};
        target = target[key];
        source = source[key];
      }
    }
    if (!ok) {
      continue;
    }
  }
  return out;
}

/** FNV-1a (32 Bit) fuer kurze, synchrone ETags. */
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** RFC-9457-Problemobjekt. */
export function problem(status, title, detail, extra = {}) {
  return {
    type: `https://httpstatuses.io/${status}`,
    title,
    status,
    detail,
    ...extra,
  };
}

