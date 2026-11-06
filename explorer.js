import { RustApi } from './rustapi.js';

// On project pages the API lives under /<repo>/ - derive the base from the current URL.
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
  command: 'Command',
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
    status.textContent = 'Type at least two characters.';
    return;
  }
  const id = ++requestId;
  status.textContent = 'Searching ...';
  try {
    const hits = await api.search(query, { types, limit: 30 });
    if (id !== requestId) {
      return;
    }
    status.textContent = `${hits.length} result${hits.length === 1 ? '' : 's'}`;
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
      status.textContent = `Error: ${error.message}`;
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
  detail.textContent = `Loading ${path} ...`;
  try {
    const body = /** @type {any} */ (await api.getPath(path));
    const data = body.data ?? body;
    const text = JSON.stringify(data, null, 2);
    detail.textContent = text.length > 20000 ? `${text.slice(0, 20000)}\n... (truncated)` : text;
    status.textContent = `Match - ${path}`;
  } catch (error) {
    detail.textContent = `Failed to load: ${error.message}`;
  }
});

api
  .meta()
  .then((value) => {
    const meta = /** @type {any} */ (value);
    status.textContent =
      `Dataset ${meta.dataset.version} - ${meta.counts.items} items, ` +
      `${meta.counts.skins} skins, ${meta.counts.commands} commands. ` +
      `buildId ${meta.buildId}.`;
  })
  .catch((error) => {
    status.textContent = `Could not load metadata: ${error.message}`;
  });
