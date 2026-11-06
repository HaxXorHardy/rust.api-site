import { RustApi } from './rustapi.js';

// Auf Projekt-Pages liegt die API unter /<repo>/ - Basis aus der aktuellen URL ableiten.
const basePath = new URL('.', window.location.href).pathname.replace(/\/$/, '');
const api = new RustApi({ staticBase: basePath });
const input = /** @type {HTMLInputElement} */ (document.getElementById('q'));
const typeSelect = /** @type {HTMLSelectElement} */ (document.getElementById('type'));
const status = /** @type {HTMLElement} */ (document.getElementById('status'));
const results = /** @type {HTMLElement} */ (document.getElementById('results'));
const detail = /** @type {HTMLElement} */ (document.getElementById('detail'));

const TYPE_LABEL = {
  item: 'Item',
  skin: 'Skin',
  building: 'Building',
  world: 'World',
  monument: 'Monument',
  update: 'Update',
  command: 'Befehl',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** @type {any} */
let timer = null;
let requestId = 0;

async function runSearch() {
  const query = input.value.trim();
  /** @type {any} */
  const types = typeSelect.value ? [typeSelect.value] : undefined;
  detail.hidden = true;
  if (!query) {
    results.innerHTML = '';
    status.textContent = 'Tippe mindestens zwei Zeichen.';
    return;
  }
  const id = ++requestId;
  status.textContent = 'Suche ...';
  try {
    const hits = await api.search(query, { types, limit: 30 });
    if (id !== requestId) {
      return;
    }
    status.textContent = `${hits.length} Treffer`;
    results.innerHTML = hits
      .map(
        (hit) =>
          `<li><a href="#" data-path="${escapeHtml(hit.path)}">` +
          `<span class="type">${escapeHtml(TYPE_LABEL[hit.type] || hit.type)}</span>` +
          `${escapeHtml(hit.name)}` +
          (hit.category ? ` <span class="muted">- ${escapeHtml(hit.category)}</span>` : '') +
          `</a></li>`,
      )
      .join('');
  } catch (error) {
    if (id === requestId) {
      status.textContent = `Fehler: ${error.message}`;
    }
  }
}

input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(runSearch, 180);
});
typeSelect.addEventListener('change', runSearch);

results.addEventListener('click', async (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const link = target.closest('a[data-path]');
  if (!link) {
    return;
  }
  event.preventDefault();
  const path = link.getAttribute('data-path');
  if (!path) {
    return;
  }
  detail.hidden = false;
  detail.textContent = `Lade ${path} ...`;
  try {
    const body = /** @type {any} */ (await api.getPath(path));
    const data = body.data ?? body;
    const text = JSON.stringify(data, null, 2);
    detail.textContent = text.length > 20000 ? `${text.slice(0, 20000)}\n... (gekuerzt)` : text;
    status.textContent = `Treffer - ${path}`;
  } catch (error) {
    detail.textContent = `Fehler beim Laden: ${error.message}`;
  }
});

api
  .meta()
  .then((value) => {
    const meta = /** @type {any} */ (value);
    status.textContent =
      `Snapshot ${meta.dataset.version} - ${meta.counts.items} Items, ` +
      `${meta.counts.skins} Skins, ${meta.counts.commands} Befehle. ` +
      `buildId ${meta.buildId}.`;
  })
  .catch((error) => {
    status.textContent = `Metadaten nicht ladbar: ${error.message}`;
  });
