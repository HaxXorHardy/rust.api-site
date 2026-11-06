/**
 * Suchkern – laeuft unveraendert im Browser, in Node und im Cloudflare Worker.
 *
 * Keine Node-APIs, kein `Intl`, keine Abhaengigkeiten. Der Index wird einmal
 * geladen; `createSearcher` baut daraus Map-Strukturen und beantwortet danach
 * Anfragen in wenigen Millisekunden (wichtig fuer das 10-ms-CPU-Limit).
 */

export const TYPE_CODES = Object.freeze({
  item: 'i',
  skin: 's',
  monument: 'm',
  building: 'b',
  world: 'w',
  update: 'u',
  command: 'c',
});

export const CODE_TYPES = Object.freeze(
  Object.fromEntries(Object.entries(TYPE_CODES).map(([name, code]) => [code, name])),
);

const TYPE_WEIGHT = {
  item: 30,
  building: 25,
  monument: 20,
  world: 20,
  update: 15,
  command: 10,
  skin: 5,
};

const PATH_BUILDERS = {
  i: (doc) => `/v1/items/${encodeURIComponent(doc.s)}.json`,
  m: (doc) => `/v1/monuments/${encodeURIComponent(doc.s)}.json`,
  b: (doc) => `/v1/building/${encodeURIComponent(doc.s)}.json`,
  w: (doc) => `/v1/world/${encodeURIComponent(doc.s)}.json`,
  u: (doc) => `/v1/updates/${encodeURIComponent(doc.s)}.json`,
  c: () => '/v1/commands/all.json',
  s: (doc) => doc.p || '/v1/skins/index.json',
};

/** Kleinschreibung, Diakritika entfernen (fuer Vergleiche). */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function tokenize(value) {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

/** Beschraenkte Levenshtein-Distanz (bricht ab, sobald `max` ueberschritten). */
export function editDistance(a, b, max = 2) {
  if (a === b) {
    return 0;
  }
  if (Math.abs(a.length - b.length) > max) {
    return max + 1;
  }
  const previous = new Array(b.length + 1);
  const current = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < rowMin) {
        rowMin = current[j];
      }
    }
    if (rowMin > max) {
      return max + 1;
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }
  return previous[b.length];
}

/** Index in ein Suchobjekt verwandeln. */
export function createSearcher(index) {
  const docs = index.docs || [];
  const postings = index.postings || {};
  const tokens = index.tokens || Object.keys(postings);
  const names = docs.map((doc) => normalizeText(doc.n));
  const nameTokenList = docs.map((doc) => tokenize(doc.n));
  const nameTokens = nameTokenList.map((list) => new Set(list));

  function lowerBound(prefix) {
    let low = 0;
    let high = tokens.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tokens[mid] < prefix) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  function prefixTokens(prefix, limit = 40) {
    const out = [];
    for (let i = lowerBound(prefix); i < tokens.length; i += 1) {
      if (!tokens[i].startsWith(prefix)) {
        break;
      }
      out.push(tokens[i]);
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  }

  function fuzzyTokens(token, limit = 6) {
    if (token.length < 4) {
      return [];
    }
    const scored = [];
    for (const candidate of prefixTokens(token.slice(0, 2), 400)) {
      if (Math.abs(candidate.length - token.length) > 2) {
        continue;
      }
      const distance = editDistance(token, candidate, 2);
      if (distance <= 2) {
        scored.push({ token: candidate, distance });
      }
    }
    scored.sort((a, b) => a.distance - b.distance || (a.token < b.token ? -1 : 1));
    return scored.slice(0, limit);
  }

  function addMatches(target, tokenList, weight) {
    for (const token of tokenList) {
      const list = postings[token];
      if (!list) {
        continue;
      }
      for (const idx of list) {
        target.set(idx, (target.get(idx) || 0) + weight);
      }
    }
  }

  /**
   * @param {string} query
   * @param {{types?: string[], limit?: number, fuzzy?: boolean}} [options]
   */
  function search(query, options = {}) {
    const normalized = normalizeText(query).trim();
    if (!normalized) {
      return [];
    }
    const limit = Math.min(Math.max(1, options.limit || 20), 100);
    const allowed =
      options.types && options.types.length > 0
        ? new Set(options.types.map((type) => TYPE_CODES[type]).filter(Boolean))
        : null;
    const queryTokens = tokenize(normalized);
    if (queryTokens.length === 0) {
      return [];
    }

    const candidates = new Map();
    for (const token of queryTokens) {
      addMatches(candidates, [token], 120);
      addMatches(candidates, prefixTokens(token, 25), 60);
    }
    if (options.fuzzy !== false && queryTokens.length === 1) {
      for (const entry of fuzzyTokens(queryTokens[0], 6)) {
        addMatches(candidates, [entry.token], entry.distance === 1 ? 45 : 20);
      }
    }

    const results = [];
    for (const [idx, base] of candidates) {
      const doc = docs[idx];
      if (!doc) {
        continue;
      }
      if (allowed && !allowed.has(doc.t)) {
        continue;
      }
      const type = CODE_TYPES[doc.t] || 'item';
      const name = names[idx];
      let score = base + (TYPE_WEIGHT[type] || 0);
      if (name === normalized) {
        score += 1000;
      } else if (queryTokens.every((token) => nameTokens[idx].has(token))) {
        // Alle Suchbegriffe kommen als ganze Woerter im Namen vor
        // ("beef" in "Raw Beef") - staerker als ein reiner Praefixtreffer.
        score += 800;
        // Grundwort am Ende ("Raw Beef" bei "beef") leicht bevorzugen.
        if (
          queryTokens.length === 1 &&
          nameTokenList[idx][nameTokenList[idx].length - 1] === queryTokens[0]
        ) {
          score += 25;
        }
      } else if (name.startsWith(normalized)) {
        score += 700;
      } else if (name.includes(normalized)) {
        score += 400;
      }
      const category = normalizeText(doc.c);
      if (category && category === normalized) {
        score += 90;
      } else if (category && category.startsWith(normalized)) {
        score += 40;
      }
      results.push({ doc, type, name, score });
    }

    results.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (a.name !== b.name) {
        return a.name < b.name ? -1 : 1;
      }
      if (a.doc.t !== b.doc.t) {
        return a.doc.t < b.doc.t ? -1 : 1;
      }
      return a.doc.s < b.doc.s ? -1 : a.doc.s > b.doc.s ? 1 : 0;
    });

    return results.slice(0, limit).map((entry) => ({
      type: entry.type,
      slug: entry.doc.s,
      name: entry.doc.n,
      category: entry.doc.c || null,
      path: (PATH_BUILDERS[entry.doc.t] || PATH_BUILDERS.i)(entry.doc),
      score: entry.score,
    }));
  }

  return { search, documents: docs.length, tokens: tokens.length };
}

