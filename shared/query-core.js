/**
 * Gemeinsame Query-Logik fuer Client und Worker.
 *
 * Beide beantworten dieselben Parameter mit identischer Semantik: Filter,
 * Sortierung, Pagination, Feldauswahl und ETag.
 */

/** @type {{defaultPerPage: number, maxPerPage: number, maxFields: number, maxQueryLength: number, maxSearchLimit: number}} */
export const LIMITS = Object.freeze({
  defaultPerPage: 25,
  maxPerPage: 200,
  maxFields: 50,
  maxQueryLength: 200,
  maxSearchLimit: 100,
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

/** Integer with bounds; `undefined` for invalid input. */
export function parseInteger(value, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    return undefined;
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    return undefined;
  }
  return number;
}

/**
 * Normalisiert Options-Objekte auf dieselben Typen/Grenzen wie readQuery.
 * @param {Record<string, any>} [options]
 * @param {Record<string, 'string'|'boolean'|'int'>} [spec]
 * @returns {Record<string, any>}
 */
export function normalizeQuery(options = {}, spec = {}) {
  const out = { ...options };
  for (const [key, type] of Object.entries(spec)) {
    if (out[key] === undefined || out[key] === null || out[key] === '') {
      continue;
    }
    if (type === 'boolean') {
      out[key] = parseBoolean(out[key]);
    } else if (type === 'int') {
      out[key] = parseInteger(out[key]);
    } else {
      out[key] = String(out[key]);
    }
  }
  if (typeof out.fields === 'string') {
    out.fields = out.fields
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, LIMITS.maxFields);
  }
  out.page = parseInteger(out.page, { min: 1 }) ?? 1;
  out.perPage = parseInteger(out.perPage, { min: 1, max: LIMITS.maxPerPage }) ?? LIMITS.defaultPerPage;
  return out;
}

/** Parameter-Spezifikationen fuer readQuery und normalizeQuery. */
/** @type {Record<string, 'string'|'boolean'|'int'>} */
export const ITEM_QUERY_SPEC = {
  q: 'string',
  category: 'string',
  craftable: 'boolean',
  recyclable: 'boolean',
  deployable: 'boolean',
  hasSkins: 'boolean',
  minStackSize: 'int',
  maxStackSize: 'int',
  sort: 'string',
  order: 'string',
};

/** @type {Record<string, 'string'|'boolean'|'int'>} */
export const SEARCH_QUERY_SPEC = {
  q: 'string',
  types: 'string',
  limit: 'int',
  fuzzy: 'boolean',
};

/** @type {Record<string, 'string'|'boolean'|'int'>} */
export const RAID_QUERY_SPEC = {
  damageType: 'string',
  grade: 'string',
  sort: 'string',
  order: 'string',
};

/** @type {Record<string, 'string'|'boolean'|'int'>} */
export const COMMAND_QUERY_SPEC = {
  q: 'string',
  category: 'string',
  adminOnly: 'boolean',
  removed: 'boolean',
  server: 'boolean',
  client: 'boolean',
};

/**
 * Reads allowed parameters from `URLSearchParams`.
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
        errors.push(`${key} must be true or false`);
      } else {
        options[key] = value;
      }
    } else if (type === 'int') {
      const value = parseInteger(raw);
      if (value === undefined) {
        errors.push(`${key} must be an integer`);
      } else {
        options[key] = value;
      }
    }
  }
  const pageRaw = params.get('page');
  const perPageRaw = params.get('perPage');
  const page = parseInteger(pageRaw, { min: 1 });
  const perPage = parseInteger(perPageRaw, { min: 1, max: LIMITS.maxPerPage });
  if (pageRaw !== null && pageRaw !== '' && page === undefined) {
    errors.push('page must be an integer >= 1');
  }
  if (perPageRaw !== null && perPageRaw !== '' && perPage === undefined) {
    errors.push(`perPage must be between 1 and ${LIMITS.maxPerPage}`);
  }
  options.page = page || 1;
  options.perPage = perPage || LIMITS.defaultPerPage;
  const fields = params.get('fields');
  if (fields) {
    const paths = fields.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (paths.length > LIMITS.maxFields) {
      errors.push(`fields allows at most ${LIMITS.maxFields} paths`);
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

/** Sorts by allowed keys, stable and without `Intl`. */
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

/** Filtert Konsolenbefehle (identisch in Client und Worker). */
export function filterCommands(commands, query = {}) {
  const tokens = normalizeText(query.q).trim().split(/\s+/).filter(Boolean);
  return commands.filter((command) => {
    if (query.category && command.category !== query.category) {
      return false;
    }
    for (const key of ['adminOnly', 'removed', 'server', 'client']) {
      if (query[key] !== undefined && command[key] !== query[key]) {
        return false;
      }
    }
    if (tokens.length > 0) {
      const haystack = normalizeText(
        `${command.fullName} ${command.name} ${command.category}`,
      );
      if (!tokens.every((token) => haystack.includes(token))) {
        return false;
      }
    }
    return true;
  });
}

const RAID_SORT_KEYS = {
  name: (block) => normalizeText(block.name),
  health: (block) => block.health ?? 0,
  requiredItems: (block) => block.attacks?.[0]?.requiredItems ?? Number.MAX_SAFE_INTEGER,
};

/** Sorts raid blocks by allowed keys. */
export function sortRaidBlocks(blocks, sort = 'name', order = 'asc') {
  const key = RAID_SORT_KEYS[sort] || RAID_SORT_KEYS.name;
  const direction = order === 'desc' ? -1 : 1;
  return [...blocks].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left === right) {
      return normalizeText(a.slug) < normalizeText(b.slug) ? -1 : 1;
    }
    return left < right ? -direction : direction;
  });
}

/**
 * Projiziert die Raid-Tabelle auf eine Schadensart, filtert nach Grade und
 * sortiert. Client und Worker teilen damit exakt dieselbe Semantik.
 */
export function filterRaid(blocks, query = {}) {
  const damageType = query.damageType || 'explosive';
  const rows = (blocks || [])
    .map((block) => ({
      slug: block.slug,
      name: block.name,
      grade: block.grade,
      category: block.category,
      health: block.health,
      path: block.path,
      attacks:
        damageType === 'explosive'
          ? block.explosive || []
          : (block.bestByDamageType || []).filter((entry) => entry.damageType === damageType),
    }))
    .filter((block) => block.attacks.length > 0);
  const graded = query.grade ? rows.filter((block) => block.grade === query.grade) : rows;
  return sortRaidBlocks(graded, query.sort || 'name', query.order || 'asc');
}

/**
 * Schneidet eine Seite heraus und liefert Metadaten.
 * @param {any[]} items
 * @param {number} [page]
 * @param {number} [perPage]
 */
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

/** Field selection with dot paths (`craft.cost`); unknown paths are dropped. */
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


