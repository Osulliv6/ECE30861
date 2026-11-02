"""Read the logical structure (tags) of a tagged PDF.

A tagged PDF carries a structure tree (catalog /StructTreeRoot) whose elements have
standard roles such as H1-H6, P, Figure, Table, TR, TH and TD (ISO 32000-1 section
14.8.4), possibly renamed through a /RoleMap. This module walks that tree directly
from the PDF objects to recover what the engine needs and the page text cannot show:

* Figure elements and their /Alt (or /ActualText) descriptions;
* tables, their rows, and which cells are header (TH) cells.

Heading text comes from MuPDF's structured text instead (see document_parser._pdf),
because mapping marked content to text requires decoding the page content.
"""
from __future__ import annotations

import re
from typing import Any

MAX_NODES = 50_000
_REF = re.compile(r'(\d+)\s+\d+\s+R')
_INLINE_DICT = re.compile(r'<<.*?>>', re.S)
TABLE_SECTIONS = {'THead', 'TBody', 'TFoot'}


def _ref(value: tuple[str, str]) -> int | None:
    if value[0] != 'xref':
        return None
    m = _REF.match(value[1])
    return int(m.group(1)) if m else None


def _name(value: tuple[str, str]) -> str | None:
    return value[1].lstrip('/') if value[0] == 'name' else None


def _string(value: tuple[str, str]) -> str | None:
    return value[1] if value[0] == 'string' else None


class StructureReader:
    def __init__(self, doc):
        self.doc = doc
        self.page_numbers = {doc.page_xref(i): i + 1 for i in range(doc.page_count)}
        self.nodes = 0
        self.visited: set[int] = set()
        self.role_map: dict[str, str] = {}

    def key(self, xref: int, name: str) -> tuple[str, str]:
        try:
            return self.doc.xref_get_key(xref, name)
        except Exception:
            return ('null', 'null')

    def _load_role_map(self, root: int):
        value = self.key(root, 'RoleMap')
        text = value[1]
        if value[0] == 'xref' and _ref(value):
            text = self.doc.xref_object(_ref(value))
        elif value[0] != 'dict':
            return
        for custom, standard in re.findall(r'/([^\s/<>\[\]()]+)\s*/([^\s/<>\[\]()]+)', text):
            self.role_map[custom] = standard

    def role(self, xref: int) -> str | None:
        role = _name(self.key(xref, 'S'))
        seen = set()
        while role in self.role_map and role not in seen:
            seen.add(role)
            role = self.role_map[role]
        return role

    def kids(self, xref: int) -> tuple[list[int], int | None]:
        """Child structure elements, plus a page hint from marked-content references."""
        value = self.key(xref, 'K')
        page = None
        refs: list[int] = []
        if value[0] == 'xref':
            refs = [_ref(value)]
        elif value[0] == 'array':
            body = value[1]
            for inline in _INLINE_DICT.findall(body):
                pg = re.search(r'/Pg\s+(\d+)\s+\d+\s+R', inline)
                if pg and page is None:
                    page = self.page_numbers.get(int(pg.group(1)))
            refs = [int(r) for r in _REF.findall(_INLINE_DICT.sub(' ', body))]
        elif value[0] == 'dict':
            pg = re.search(r'/Pg\s+(\d+)\s+\d+\s+R', value[1])
            if pg:
                page = self.page_numbers.get(int(pg.group(1)))
        elements = []
        for ref in refs:
            if ref is None:
                continue
            if _name(self.key(ref, 'S')) is not None:
                elements.append(ref)
            elif page is None:  # an indirect marked-content or object reference
                page = self.page_numbers.get(_ref(self.key(ref, 'Pg')) or -1)
        return elements, page

    def read(self) -> dict[str, Any] | None:
        doc = self.doc
        catalog = doc.pdf_catalog()
        root = _ref(self.key(catalog, 'StructTreeRoot'))
        if not root:
            return None
        self._load_role_map(root)
        out = {'marked': self.key(catalog, 'MarkInfo/Marked') == ('bool', 'true'),
               'elements': 0, 'figures': [], 'tables': [], 'headings': 0, 'truncated': False}
        top, _ = self.kids(root)
        for kid in top:
            self._walk(kid, None, out)
        return out

    def _walk(self, xref: int, inherited_page: int | None, out: dict) -> int | None:
        """Visit one element; returns the first page number seen in its subtree."""
        if xref in self.visited:
            return None
        if self.nodes >= MAX_NODES:
            out['truncated'] = True
            return None
        self.visited.add(xref)
        self.nodes += 1
        out['elements'] += 1
        role = self.role(xref)
        own_page = self.page_numbers.get(_ref(self.key(xref, 'Pg')) or -1)
        kids, hint = self.kids(xref)
        page = own_page or hint or inherited_page
        if role and re.fullmatch(r'H[1-6]?', role):
            out['headings'] += 1
        if role == 'Figure':
            alt = _string(self.key(xref, 'Alt'))
            if not (alt or '').strip():
                alt = _string(self.key(xref, 'ActualText'))
            out['figures'].append({'alt': alt.strip() if alt and alt.strip() else None, 'page': page})
            for kid in kids:  # nested figures still need their own descriptions
                self._walk(kid, page, out)
            return page
        if role == 'Table':
            rows: list[list[str]] = []
            first_page = self._collect_rows(xref, page, rows, out)
            out['tables'].append({'rows': rows, 'page': page or first_page})
            return page or first_page
        first = None
        for kid in kids:
            found = self._walk(kid, page, out)
            first = first or found
        return own_page or hint or first

    def _collect_rows(self, xref: int, page: int | None, rows: list, out: dict) -> int | None:
        first = None
        kids, _ = self.kids(xref)
        for kid in kids:
            if kid in self.visited or self.nodes >= MAX_NODES:
                continue
            role = self.role(kid)
            if role in TABLE_SECTIONS:
                self.visited.add(kid)
                self.nodes += 1
                found = self._collect_rows(kid, page, rows, out)
                first = first or found
            elif role == 'TR':
                self.visited.add(kid)
                self.nodes += 1
                cells, _ = self.kids(kid)
                rows.append([self.role(c) or '' for c in cells])
                for cell in cells:  # figures and nested tables inside cells
                    found = self._walk(cell, page, out)
                    first = first or found
            else:
                found = self._walk(kid, page, out)
                first = first or found
        return first


def read_structure(doc) -> dict[str, Any] | None:
    """Return the tag summary of a PDF, or None when it has no structure tree."""
    try:
        return StructureReader(doc).read()
    except Exception:
        return None
