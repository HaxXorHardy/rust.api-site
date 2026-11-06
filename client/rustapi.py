"""Small client for the static Rust API (standard library only).

Examples::

    python client/rustapi.py item raw-beef
    python client/rustapi.py search beef --types item --limit 5
    python client/rustapi.py items --category Food --per-page 3
    python client/rustapi.py raid --damage-type explosive --sort requiredItems

Without ``--base`` the client expects the API at ``http://127.0.0.1:8000``
(``npm run api:serve``).
"""

from __future__ import annotations

import argparse
import bisect
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class RustApiError(Exception):
    """Error carrying the HTTP status and problem details."""

    def __init__(self, message: str, status: int | None = None, problem: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.problem = problem


# --------------------------------------------------------------------------- #
# Search ranking (mirror of web/search-core.js, without fuzzy)
# --------------------------------------------------------------------------- #

TYPE_CODES = {
    "item": "i",
    "skin": "s",
    "monument": "m",
    "building": "b",
    "world": "w",
    "update": "u",
    "command": "c",
}
CODE_TYPES = {code: name for name, code in TYPE_CODES.items()}
TYPE_WEIGHT = {"i": 30, "b": 25, "m": 20, "w": 20, "u": 15, "c": 10, "s": 5}


def _normalize(value: Any) -> str:
    text = str(value or "").lower()
    return "".join(char for char in unicodedata.normalize("NFKD", text) if not unicodedata.combining(char))


def _tokenize(value: Any) -> list[str]:
    return [token for token in re.split(r"[^a-z0-9]+", _normalize(value)) if len(token) >= 2]


def _prefix_tokens(tokens: list[str], prefix: str, limit: int = 25) -> list[str]:
    start = bisect.bisect_left(tokens, prefix)
    out: list[str] = []
    for token in tokens[start:]:
        if not token.startswith(prefix):
            break
        out.append(token)
        if len(out) >= limit:
            break
    return out


def _doc_path(doc: dict[str, Any]) -> str:
    code = doc.get("t")
    slug = urllib.parse.quote(str(doc.get("s") or ""))
    if code == "i":
        return f"/v1/items/{slug}.json"
    if code == "m":
        return f"/v1/monuments/{slug}.json"
    if code == "b":
        return f"/v1/building/{slug}.json"
    if code == "w":
        return f"/v1/world/{slug}.json"
    if code == "u":
        return f"/v1/updates/{slug}.json"
    if code == "c":
        return "/v1/commands/all.json"
    return doc.get("p") or "/v1/skins/index.json"


# --------------------------------------------------------------------------- #
# Query semantics (mirror of web/query-core.js)
# --------------------------------------------------------------------------- #


def _as_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None or value == "":
        return None
    text = str(value).lower()
    if text in {"true", "1", "yes", "ja"}:
        return True
    if text in {"false", "0", "no", "nein"}:
        return False
    return None


def _int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _pick(query: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {key: query[key] for key in keys if query.get(key) is not None}


def _page_options(query: dict[str, Any]) -> tuple[int, int]:
    page = max(1, _int(query.get("page"), 1))
    per_page = min(200, max(1, _int(query.get("perPage"), 25)))
    return page, per_page


def _filter_items(items: list[dict[str, Any]], query: dict[str, Any]) -> list[dict[str, Any]]:
    tokens = _normalize(query.get("q")).split()
    category = query.get("category")
    flags = {key: _as_bool(query.get(key)) for key in ("craftable", "recyclable", "deployable", "hasSkins")}
    min_stack = query.get("minStackSize")
    max_stack = query.get("maxStackSize")
    selected: list[dict[str, Any]] = []
    for item in items:
        if category and _normalize(item.get("category")) != _normalize(category):
            continue
        if any(value is not None and item.get(key) != value for key, value in flags.items()):
            continue
        if min_stack is not None and (item.get("stackSize") or 0) < int(min_stack):
            continue
        if max_stack is not None and (item.get("stackSize") or 0) > int(max_stack):
            continue
        if tokens:
            haystack = _normalize(
                f"{item.get('name')} {item.get('slug')} {item.get('id')} "
                f"{item.get('shortName')} {item.get('category')}"
            )
            if not all(token in haystack for token in tokens):
                continue
        selected.append(item)
    return selected


_ITEM_SORT_KEYS = {
    "name": lambda item: _normalize(item.get("name")),
    "slug": lambda item: _normalize(item.get("slug")),
    "category": lambda item: _normalize(item.get("category")),
    "stackSize": lambda item: item.get("stackSize") or 0,
}


def _sort_items(items: list[dict[str, Any]], sort: str = "name", order: str = "asc") -> list[dict[str, Any]]:
    key = _ITEM_SORT_KEYS.get(sort, _ITEM_SORT_KEYS["name"])
    ordered = sorted(items, key=lambda item: _normalize(item.get("slug")))
    return sorted(ordered, key=key, reverse=order == "desc")


def _paginate(items: list[Any], page: int = 1, per_page: int = 25) -> dict[str, Any]:
    total = len(items)
    pages = max(1, -(-total // per_page))
    current = min(max(1, page), pages)
    start = (current - 1) * per_page
    return {
        "rows": items[start : start + per_page],
        "pagination": {
            "page": current,
            "perPage": per_page,
            "total": total,
            "pages": pages,
            "next": current + 1 if current < pages else None,
            "prev": current - 1 if current > 1 else None,
        },
    }


def _project_fields(value: Any, fields: Any) -> Any:
    if not isinstance(fields, (list, tuple)) or not fields:
        return value
    out: dict[str, Any] = {}
    for path in fields:
        parts = [part for part in str(path).split(".") if part]
        source = value
        target = out
        for index, key in enumerate(parts):
            if not isinstance(source, dict) or key not in source:
                break
            if index == len(parts) - 1:
                target[key] = source[key]
            else:
                target = target.setdefault(key, {})
                source = source[key]
    return out


def _raid_required(block: dict[str, Any]) -> Any:
    attacks = block.get("attacks") or []
    if attacks and attacks[0].get("requiredItems") is not None:
        return attacks[0]["requiredItems"]
    return float("inf")


_RAID_SORT_KEYS = {
    "name": lambda block: _normalize(block.get("name")),
    "health": lambda block: block.get("health") or 0,
    "requiredItems": _raid_required,
}


def _filter_raid(blocks: list[dict[str, Any]], query: dict[str, Any]) -> list[dict[str, Any]]:
    damage_type = query.get("damageType") or "explosive"
    rows = []
    for block in blocks:
        attacks = (
            block.get("explosive") or []
            if damage_type == "explosive"
            else [
                entry
                for entry in block.get("bestByDamageType") or []
                if entry.get("damageType") == damage_type
            ]
        )
        if not attacks:
            continue
        rows.append(
            {
                "slug": block.get("slug"),
                "name": block.get("name"),
                "grade": block.get("grade"),
                "category": block.get("category"),
                "health": block.get("health"),
                "path": block.get("path"),
                "attacks": attacks,
            }
        )
    grade = query.get("grade")
    if grade:
        rows = [block for block in rows if block.get("grade") == grade]
    key = _RAID_SORT_KEYS.get(query.get("sort") or "name", _RAID_SORT_KEYS["name"])
    ordered = sorted(rows, key=lambda block: _normalize(block.get("slug")))
    return sorted(ordered, key=key, reverse=(query.get("order") or "asc") == "desc")


def _filter_commands(commands: list[dict[str, Any]], query: dict[str, Any]) -> list[dict[str, Any]]:
    tokens = _normalize(query.get("q")).split()
    category = query.get("category")
    flags = {key: _as_bool(query.get(key)) for key in ("adminOnly", "removed", "server", "client")}
    selected: list[dict[str, Any]] = []
    for command in commands:
        if category and command.get("category") != category:
            continue
        if any(value is not None and command.get(key) != value for key, value in flags.items()):
            continue
        if tokens:
            haystack = _normalize(
                f"{command.get('fullName')} {command.get('name')} {command.get('category')}"
            )
            if not all(token in haystack for token in tokens):
                continue
        selected.append(command)
    return selected




class RustApi:
    def __init__(
        self, static_base: str = "", dynamic_base: str = "", timeout: float = 20.0
    ) -> None:
        self.static_base = (static_base or "").rstrip("/")
        self.dynamic_base = (dynamic_base or "").rstrip("/")
        self.timeout = timeout

    # ------------------------------------------------------------------ #
    # intern
    # ------------------------------------------------------------------ #
    def _get(self, url: str) -> Any:
        request = urllib.request.Request(url, headers={"accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read()
        except urllib.error.HTTPError as error:
            body = None
            try:
                body = json.loads(error.read().decode("utf-8"))
            except Exception:  # noqa: BLE001 - Fehlerkoerper ist optional
                body = None
            raise RustApiError(f"HTTP {error.code} for {url}", error.code, body) from error
        except urllib.error.URLError as error:
            raise RustApiError(f"Verbindung fehlgeschlagen: {error.reason}") from error
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RustApiError(f"Invalid JSON response for {url}") from error

    def _static(self, path: str, **params: Any) -> Any:
        url = f"{self.static_base}{path}"
        if params:
            url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        return self._get(url)

    def _dynamic(self, path: str, **params: Any) -> Any:
        query = {}
        for key, value in params.items():
            if value is None:
                continue
            query[key] = ",".join(value) if isinstance(value, (list, tuple)) else value
        url = f"{self.dynamic_base}{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        return self._get(url)

    # ------------------------------------------------------------------ #
    # Ressourcen
    # ------------------------------------------------------------------ #
    def meta(self) -> dict[str, Any]:
        return self._static("/v1/meta.json")["data"]

    def item(self, slug: str) -> dict[str, Any]:
        return self._static(f"/v1/items/{urllib.parse.quote(slug)}.json")["data"]

    def items_index(self) -> list[dict[str, Any]]:
        return self._static("/v1/items/index.json")["data"]

    def categories(self) -> list[dict[str, Any]]:
        return self._static("/v1/categories.json")["data"]

    def building(self, slug: str) -> dict[str, Any]:
        return self._static(f"/v1/building/{urllib.parse.quote(slug)}.json")["data"]

    def monument(self, slug: str) -> dict[str, Any]:
        return self._static(f"/v1/monuments/{urllib.parse.quote(slug)}.json")["data"]

    def world(self, slug: str) -> dict[str, Any]:
        return self._static(f"/v1/world/{urllib.parse.quote(slug)}.json")["data"]

    def skins_for_item(self, slug: str) -> list[dict[str, Any]]:
        return self._static(f"/v1/skins/by-item/{urllib.parse.quote(slug)}.json")["data"]

    # ------------------------------------------------------------------ #
    # Lists and search (worker when available, static otherwise)
    # ------------------------------------------------------------------ #
    def items(self, **query: Any) -> dict[str, Any]:
        if self.dynamic_base:
            try:
                return self._dynamic("/v1/items", **query)
            except RustApiError as error:
                if error.status is not None and error.status != 429 and error.status < 500:
                    raise
        selected = _filter_items(self.items_index(), query)
        ordered = _sort_items(
            selected,
            str(query.get("sort") or "name"),
            str(query.get("order") or "asc"),
        )
        page, per_page = _page_options(query)
        paged = _paginate(ordered, page, per_page)
        return {
            "data": [_project_fields(row, query.get("fields")) for row in paged["rows"]],
            "meta": {
                "pagination": paged["pagination"],
                "filters": _pick(
                    query,
                    (
                        "q",
                        "category",
                        "craftable",
                        "recyclable",
                        "deployable",
                        "hasSkins",
                        "minStackSize",
                        "maxStackSize",
                        "sort",
                        "order",
                    ),
                ),
            },
        }

    def search(
        self,
        query: str,
        types: list[str] | None = None,
        limit: int = 20,
        fuzzy: bool = True,
    ) -> list[dict[str, Any]]:
        if self.dynamic_base:
            try:
                return self._dynamic(
                    "/v1/search", q=query, types=types, limit=limit, fuzzy=str(fuzzy).lower()
                )["data"]
            except RustApiError as error:
                if error.status is not None and error.status != 429 and error.status < 500:
                    raise
        # Without a worker: use the search index with identical ranking (no fuzzy).
        index = self._search_index()
        tokens: list[str] = index.get("tokens") or []
        postings: dict[str, list[int]] = index.get("postings") or {}
        docs: list[dict[str, Any]] = index.get("docs") or []
        normalized = _normalize(query).strip()
        query_tokens = _tokenize(normalized)
        if not query_tokens:
            return []
        allowed = {TYPE_CODES[name] for name in (types or []) if name in TYPE_CODES}
        candidates: dict[int, int] = {}
        for token in query_tokens:
            for idx in postings.get(token, []):
                candidates[idx] = candidates.get(idx, 0) + 120
            for prefix in _prefix_tokens(tokens, token):
                for idx in postings.get(prefix, []):
                    candidates[idx] = candidates.get(idx, 0) + 60

        scored: list[tuple[int, str, str, dict[str, Any]]] = []
        for idx, base in candidates.items():
            doc = docs[idx]
            code = str(doc.get("t"))
            if allowed and code not in allowed:
                continue
            name = _normalize(doc.get("n"))
            name_tokens = _tokenize(name)
            score = base + TYPE_WEIGHT.get(code, 0)
            if name == normalized:
                score += 1000
            elif all(token in name_tokens for token in query_tokens):
                score += 800
                if len(query_tokens) == 1 and name_tokens and name_tokens[-1] == query_tokens[0]:
                    score += 25
            elif name.startswith(normalized):
                score += 700
            elif normalized in name:
                score += 400
            category = _normalize(doc.get("c"))
            if category and category == normalized:
                score += 90
            elif category and category.startswith(normalized):
                score += 40
            scored.append((score, name, code, doc))

        scored.sort(key=lambda entry: (-entry[0], entry[1], entry[2], str(entry[3].get("s"))))
        return [
            {
                "type": CODE_TYPES.get(code, "item"),
                "slug": doc.get("s"),
                "name": doc.get("n"),
                "category": doc.get("c"),
                "path": _doc_path(doc),
                "score": score,
            }
            for score, _name, code, doc in scored[: max(1, min(int(limit), 100))]
        ]

    def _search_index(self) -> dict[str, Any]:
        if not hasattr(self, "_index"):
            # The search index is its own document without a data/meta envelope.
            self._index = self._static("/v1/search/index.json")
        return self._index

    def raid_costs(self, **query: Any) -> dict[str, Any]:
        if self.dynamic_base:
            try:
                return self._dynamic("/v1/building/raid-costs", **query)
            except RustApiError as error:
                if error.status is not None and error.status != 429 and error.status < 500:
                    raise
        table = self._static("/v1/building/raid-costs.json")["data"]
        blocks = _filter_raid(table.get("blocks") or [], query)
        page, per_page = _page_options(query)
        paged = _paginate(blocks, page, per_page)
        return {
            "data": paged["rows"],
            "meta": {
                "pagination": paged["pagination"],
                "damageType": query.get("damageType") or "explosive",
                "grade": query.get("grade"),
            },
        }

    def commands(self, **query: Any) -> dict[str, Any]:
        if self.dynamic_base:
            try:
                return self._dynamic("/v1/commands", **query)
            except RustApiError as error:
                if error.status is not None and error.status != 429 and error.status < 500:
                    raise
        commands = self._static("/v1/commands/all.json")["data"]
        rows = _filter_commands(commands, query)
        page, per_page = _page_options(query)
        paged = _paginate(rows, page, per_page)
        return {
            "data": paged["rows"],
            "meta": {
                "pagination": paged["pagination"],
                "filters": _pick(
                    query,
                    ("q", "category", "adminOnly", "removed", "server", "client"),
                ),
            },
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Client for the static Rust API")
    parser.add_argument("--base", default="http://127.0.0.1:8000", help="static base URL")
    parser.add_argument("--dynamic", default="", help="worker base URL (optional)")
    sub = parser.add_subparsers(dest="command", required=True)

    item = sub.add_parser("item", help="item detail")
    item.add_argument("slug")

    sub.add_parser("meta", help="metadata")
    sub.add_parser("categories", help="categories")

    search = sub.add_parser("search", help="search")
    search.add_argument("query")
    search.add_argument("--types", default="")
    search.add_argument("--limit", type=int, default=10)

    items = sub.add_parser("items", help="item list")
    items.add_argument("--q", default="")
    items.add_argument("--category", default="")
    items.add_argument("--page", type=int, default=1)
    items.add_argument("--per-page", type=int, default=10)

    raid = sub.add_parser("raid", help="raid costs")
    raid.add_argument("--damage-type", default="explosive")
    raid.add_argument("--sort", default="name")
    raid.add_argument("--order", default="asc")
    raid.add_argument("--per-page", type=int, default=10)

    args = parser.parse_args(argv)
    api = RustApi(args.base, args.dynamic)

    try:
        if args.command == "meta":
            result: Any = api.meta()
        elif args.command == "categories":
            result = api.categories()
        elif args.command == "item":
            result = api.item(args.slug)
        elif args.command == "search":
            types = [entry for entry in args.types.split(",") if entry]
            result = api.search(args.query, types=types or None, limit=args.limit)
        elif args.command == "items":
            result = api.items(
                q=args.q or None,
                category=args.category or None,
                page=args.page,
                perPage=args.per_page,
            )
        elif args.command == "raid":
            result = api.raid_costs(
                damageType=args.damage_type,
                sort=args.sort,
                order=args.order,
                perPage=args.per_page,
            )
        else:  # pragma: no cover - argparse covers every case
            return 2
    except RustApiError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        if error.problem:
            print(json.dumps(error.problem, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


