"""Review PDF page properties that don't follow from the presence of tags."""
from collections import Counter
import math
import re
import subprocess
from time import monotonic

import pymupdf as fitz

OCR_PAGE_LIMIT = 3
OCR_TIME_LIMIT = 4
OCR_MAX_PIXELS = 2_000_000

_MARKED_TEXT = re.compile(rb'/[^\s/<>()\[\]]+\s*<<\s*/MCID\s+(\d+)[^>]*>>\s*BDC(.*?)EMC', re.S)
_SIMPLE_TEXT = re.compile(rb'\s*BT\b[^()<>\[\]]*\(([ -~]+)\)\s*Tj\s*ET\s*')


def block_text(block):
    return ' '.join(' '.join(
        span.get('text', '') for line in block.get('lines', []) for span in line.get('spans', [])
    ).split())


def match_marked_text(doc, page, blocks):
    """Match only unique extractions of a simple literal Tj by text and MCID."""
    literals = {}
    ids = Counter()
    for stream in page.get_contents():
        for match in _MARKED_TEXT.finditer(doc.xref_stream(stream) or b''):
            mcid = int(match.group(1))
            ids[mcid] += 1
            literal = _SIMPLE_TEXT.fullmatch(match.group(2))
            if literal and not any(char in literal.group(1) for char in (b'(', b')', b'\\')):
                literals[mcid] = ' '.join(literal.group(1).decode('ascii').split())
    raw_counts = Counter(literals.values())
    block_counts = Counter(map(block_text, blocks))
    by_text = {text: mcid for mcid, text in literals.items()
               if text and ids[mcid] == raw_counts[text] == block_counts[text] == 1}
    return [by_text.get(block_text(block)) for block in blocks]


def reading_order_differs(blocks, tag_order):
    """Compare unambiguous, single-direction text in simple one/two-column layouts."""
    if len(blocks) < 2 or len(blocks) != len(tag_order):
        return False
    boxes = [fitz.Rect(block['bbox']) for block in blocks]
    if any(not block_text(block).isascii() or any(line.get('dir') != (1.0, 0.0)
           for line in block.get('lines', [])) for block in blocks):
        return False
    by_x = sorted(range(len(boxes)), key=lambda i: boxes[i].x0)
    columns = [by_x]
    splits = [i for i in range(1, len(by_x)) if boxes[by_x[i]].x0 - boxes[by_x[i - 1]].x0 >= 36]
    if splits:
        if len(splits) != 1:
            return False
        split = splits[0]
        left, right = by_x[:split], by_x[split:]
        if min(len(left), len(right)) < 2 or max(boxes[i].x1 for i in left) + 12 > min(boxes[i].x0 for i in right):
            return False
        columns = [left, right]
    visual = []
    for column in columns:
        vertical = sorted(column, key=lambda i: boxes[i].y0)
        if any(boxes[a].y1 > boxes[b].y0 for a, b in zip(vertical, vertical[1:])):
            return False
        visual.extend(vertical)
    return list(tag_order) != visual


def scan_candidate(page, text_blocks):
    if any(any(char.isalnum() for char in block_text(block)) for block in text_blocks):
        return False
    area = page.rect.get_area()
    return bool(area) and any(
        (fitz.Rect(image['bbox']) & page.rect).get_area() >= 0.6 * area
        for image in page.get_image_info()
    )


class ScanOCR:
    """Recognize a few raster pages without extending the parser's overall timeout."""

    def __init__(self):
        self.remaining = OCR_PAGE_LIMIT
        self.time_left = OCR_TIME_LIMIT
        self.unavailable = False

    def check(self, page):
        if self.unavailable:
            return 'unavailable'
        if self.remaining <= 0 or self.time_left <= 0:
            return 'budget'
        self.remaining -= 1
        started = monotonic()
        try:
            zoom = min(150 / 72, math.sqrt(OCR_MAX_PIXELS / page.rect.get_area()))
            image = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY)
            timeout = self.time_left - (monotonic() - started)
            if timeout <= 0:
                return 'budget'
            result = subprocess.run(
                ['tesseract', 'stdin', 'stdout', '-l', 'eng'],
                input=image.tobytes('png'), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                check=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return 'budget'
        except (OSError, subprocess.CalledProcessError):
            self.unavailable = True
            return 'unavailable'
        except RuntimeError:
            return 'unavailable'
        finally:
            self.time_left -= monotonic() - started
        return 'text' if re.search(rb'[A-Za-z0-9]{2,}', result.stdout) else 'no_text'


def widget_label(doc, widget):
    """Use the tooltip (/TU), or the caption (/MK/CA) for a pushbutton."""
    if widget.field_type == fitz.PDF_WIDGET_TYPE_BUTTON:
        kind, value = doc.xref_get_key(widget.xref, 'MK/CA')
        if kind == 'string' and value.strip():
            return value.strip()
    seen = set()
    xref = widget.xref
    while xref not in seen:
        seen.add(xref)
        kind, value = doc.xref_get_key(xref, 'TU')
        if kind == 'string' and value.strip():
            return value.strip()
        kind, parent = doc.xref_get_key(xref, 'Parent')
        if kind != 'xref':
            return ''
        xref = int(parent.split()[0])
    return ''
