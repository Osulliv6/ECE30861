from pathlib import Path
import shutil
import subprocess

import pymupdf as fitz
import pytest

from parser.document_parser import parse_document
from parser.pdf_review import ScanOCR, match_marked_text

FIXTURES = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'documents'


def make_scan(tmp_path, *, words=None, pages=1):
    path = tmp_path / 'scan.pdf'
    with fitz.open() as source, fitz.open() as output:
        page = source.new_page(width=350, height=250)
        if words:
            page.insert_text((28, 55), words, fontsize=22)
        else:
            page.draw_circle((170, 120), 60, fill=(0.2, 0.4, 0.8))
        raster = page.get_pixmap(matrix=fitz.Matrix(2, 2))
        for _ in range(pages):
            scanned = output.new_page(width=350, height=250)
            scanned.insert_image(scanned.rect, pixmap=raster)
        output.save(path, deflate=True)
    return path


@pytest.mark.skipif(shutil.which('tesseract') is None, reason='Tesseract is a container runtime dependency')
def test_ocr_distinguishes_scanned_words_from_an_image_without_text(tmp_path):
    for words, expected in [('Course schedule', 'text'), (None, 'no_text')]:
        result = parse_document(make_scan(tmp_path, words=words))
        assert [e['ocr'] for e in result['elements'] if e['type'] == 'pdf_scan'] == [expected]
        assert not any(e.get('text') == words for e in result['elements'] if e['type'] == 'text')


def test_mixed_scan_preserves_native_text_and_exposes_unavailable_ocr(monkeypatch):
    def unavailable(*args, **kwargs):
        raise FileNotFoundError('tesseract')

    monkeypatch.setattr(subprocess, 'run', unavailable)
    result = parse_document(FIXTURES / 'mixed-scan.pdf')
    assert any(e['type'] == 'text' and e['location']['page'] == 1 and 'Native digital text' in e['text']
               for e in result['elements'])
    assert [(e['location']['page'], e['ocr']) for e in result['elements'] if e['type'] == 'pdf_scan'] == [(2, 'unavailable')]


def test_ocr_timeout_and_page_budget_leave_actionable_candidates(tmp_path, monkeypatch):
    def timed_out(args, **kwargs):
        raise subprocess.TimeoutExpired(args, kwargs['timeout'])

    monkeypatch.setattr(subprocess, 'run', timed_out)
    result = parse_document(make_scan(tmp_path, pages=1))
    assert [e['ocr'] for e in result['elements'] if e['type'] == 'pdf_scan'] == ['budget']

    def success(*args, **kwargs):
        return subprocess.CompletedProcess(args, 0, stdout=b'Course schedule')

    monkeypatch.setattr(subprocess, 'run', success)
    with fitz.open(make_scan(tmp_path, pages=4)) as doc:
        runner = ScanOCR()
        assert [runner.check(page) for page in doc] == ['text', 'text', 'text', 'budget']


def test_equal_block_counts_do_not_map_duplicate_text_and_mixed_pages_record_uncertainty(tmp_path):
    path = tmp_path / 'ambiguous.pdf'
    with fitz.open(FIXTURES / 'tagged.pdf') as doc:
        second = doc[1]
        stream = second.get_contents()[0]
        original = doc.xref_stream(stream)
        doc.update_stream(stream, original.replace(b'(One)', b'(Week)'))
        heading_tag = next(x for x in range(1, doc.xref_length())
                           if doc.xref_get_key(x, 'Pg') == ('xref', '4 0 R')
                           and doc.xref_get_key(x, 'K') == ('int', '1'))
        doc.xref_set_key(heading_tag, 'S', '/H2')
        doc.xref_set_key(second.xref, 'StructParents', 'null')
        flags = fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES
        blocks = second.get_text('dict', flags=flags)['blocks']
        assert len(blocks) == 2
        assert match_marked_text(doc, second, blocks) == [None, None]
        doc.save(path)
    parsed = parse_document(path)
    assert parsed['metadata']['unknown_heading_pages'] == [2]
    assert [(e['text'], e['location']['page']) for e in parsed['elements'] if e['type'] == 'heading'] == [
        ('Course Syllabus', 1), ('Grading', 1),
    ]
