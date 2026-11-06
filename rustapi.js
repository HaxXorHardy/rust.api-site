/**
 * Client fuer die statische API mit optionalem Worker-Fallback.
 *
 * Alle Methoden funktionieren ohne Worker (dann lokal gefiltert) und mit
 * Worker (dann serverseitig). Bei 429/5xx faellt der Client automatisch auf
 * die lokale Auswertung zurueck.
 */

import { createSearcher } from './shared/search-core.js';
import {
  COMMAND_QUERY_SPEC,
  ITEM_QUERY_SPEC,
  RAID_QUERY_SPEC,
  filterCommands,
  filterItems,
  filterRaid,
  normalizeQuery,
  paginate,
  projectFields,
  sortItems,
} from './shared/query-core.js';

export class RustApiError extends Error {
  constructor(message, status, problem) {
    super(message);
    this.name = 'RustApiError';
    this.status = status;
    this.problem = problem;
  }
}

export class RustApi {
  constructor({ staticBase = '', dynamicBase = '', fetchImpl = null } = {}) {
    this.staticBase = String(staticBase || '').replace(/\/$/, '');
    this.dynamicBase = String(dynamicBase || '').replace(/\/$/, '');
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this._cache = new Map();
    this._searcher = null;
  }

  async #json(url) {
    const response = await this.fetch(url);
    const text = await response.text();
    /** @type {any} */
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (error) {
        if (response.ok) {
          throw new RustApiError(
            `Ungueltige JSON-Antwort von ${url}: ${text.slice(0, 80)}`,
            response.status,
            null,
          );
        }
        body = null;
      }
    }
    if (!response.ok) {
      throw new RustApiError(`${response.status} ${response.statusText}`, response.status, body);
    }
    return body;
  }

  async #cached(path) {
    if (!this._cache.has(path)) {
      const promise = this.#json(`${this.staticBase}${path}`).catch((error) => {
        // Fehlgeschlagene Anfragen duerfen den Cache nicht vergiften.
        this._cache.delete(path);
        throw error;
      });
      this._cache.set(path, promise);
    }
    return this._cache.get(path);
  }

  async #dynamic(path, params = {}) {
    const url = new URL(`${this.dynamicBase}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) {
        continue;
      }
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    return this.#json(url.toString());
  }

  static #shouldFallback(error) {
    return error instanceof RustApiError && (error.status === 429 || error.status >= 500);
  }

  /**
   * Bevorzugt den Worker, faellt bei 429/5xx auf die lokale Auswertung zurueck.
   * @param {string} path
   * @param {Record<string, any>} params
   * @param {(body: any) => any} fromDynamic
   * @param {() => Promise<any>} fromStatic
   */
  async #withFallback(path, params, fromDynamic, fromStatic) {
    if (this.dynamicBase) {
      try {
        return fromDynamic(await this.#dynamic(path, params));
      } catch (error) {
        if (!RustApi.#shouldFallback(error)) {
          throw error;
        }
      }
    }
    return fromStatic();
  }

  async meta() {
    return (await this.#cached('/v1/meta.json')).data;
  }

  async getPath(path) {
    return this.#json(`${this.staticBase}${path}`);
  }

  async item(slug) {
    const body = await this.#json(
      `${this.staticBase}/v1/items/${encodeURIComponent(slug)}.json`,
    );
    return body.data;
  }

  async itemRaw(slug) {
    const body = await this.#json(
      `${this.staticBase}/v1/items/${encodeURIComponent(slug)}.raw.json`,
    );
    return body.data;
  }

  async itemsIndex() {
    return (await this.#cached('/v1/items/index.json')).data;
  }

  async categories() {
    return (await this.#cached('/v1/categories.json')).data;
  }

  async building(slug) {
    const body = await this.#json(
      `${this.staticBase}/v1/building/${encodeURIComponent(slug)}.json`,
    );
    return body.data;
  }

  async monument(slug) {
    const body = await this.#json(
      `${this.staticBase}/v1/monuments/${encodeURIComponent(slug)}.json`,
    );
    return body.data;
  }

  async world(slug) {
    const body = await this.#json(`${this.staticBase}/v1/world/${encodeURIComponent(slug)}.json`);
    return body.data;
  }

  async skinsForItem(slug) {
    const body = await this.#json(
      `${this.staticBase}/v1/skins/by-item/${encodeURIComponent(slug)}.json`,
    );
    return body.data;
  }

  async updates() {
    return (await this.#cached('/v1/updates/index.json')).data;
  }

  /**
   * Item-Liste mit Filter, Sortierung und Pagination.
   * @returns {Promise<{items: object[], pagination: object, source: string}>}
   */
  async items(options = {}) {
    return this.#withFallback(
      '/v1/items',
      options,
      (body) => ({ items: body.data, pagination: body.meta.pagination, source: 'dynamic' }),
      async () => {
        const normal = normalizeQuery(options, ITEM_QUERY_SPEC);
        const index = await this.itemsIndex();
        const filtered = filterItems(index, normal);
        const sorted = sortItems(filtered, normal.sort || 'name', normal.order || 'asc');
        const { rows, pagination } = paginate(sorted, normal.page, normal.perPage);
        return {
          items: rows.map((row) => projectFields(row, normal.fields)),
          pagination,
          source: 'static',
        };
      },
    );
  }

  /**
   * Gewichtete Suche. Nutzt den Worker, sonst den lokalen Index.
   * @returns {Promise<Array<{type: string, slug: string, name: string, category: string|null, path: string, score: number}>>}
   */
  async search(query, options = {}) {
    return this.#withFallback(
      '/v1/search',
      { q: query, types: options.types, limit: options.limit, fuzzy: options.fuzzy },
      (body) => body.data,
      async () => {
        if (!this._searcher) {
          // Der Suchindex ist ein eigenes Dokument (ohne data/meta-Huelle).
          const index = await this.#cached('/v1/search/index.json');
          this._searcher = createSearcher(index);
        }
        return this._searcher.search(query, options);
      },
    );
  }

  /** Raid-Kosten, wahlweise je Schadensart. */
  async raidCosts(options = {}) {
    return this.#withFallback(
      '/v1/building/raid-costs',
      options,
      (body) => ({ blocks: body.data, pagination: body.meta.pagination, source: 'dynamic' }),
      async () => {
        const normal = normalizeQuery(options, RAID_QUERY_SPEC);
        const table = (await this.#cached('/v1/building/raid-costs.json')).data;
        const blocks = filterRaid(table.blocks, normal);
        const { rows, pagination } = paginate(blocks, normal.page, normal.perPage);
        return { blocks: rows, pagination, source: 'static' };
      },
    );
  }

  /** Konsolenbefehle mit Filter. */
  async commands(options = {}) {
    return this.#withFallback(
      '/v1/commands',
      options,
      (body) => ({ commands: body.data, pagination: body.meta.pagination, source: 'dynamic' }),
      async () => {
        const normal = normalizeQuery(options, COMMAND_QUERY_SPEC);
        const all = (await this.#cached('/v1/commands/all.json')).data;
        const rows = filterCommands(all, normal);
        const { rows: pageRows, pagination } = paginate(rows, normal.page, normal.perPage);
        return { commands: pageRows, pagination, source: 'static' };
      },
    );
  }
}


