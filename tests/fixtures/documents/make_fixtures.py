"""Regenerates the synthetic DOCX/PDF/TXT fixtures used by tests/integration.test.mjs.

Run from the repo root: accessibility-parser/.venv/bin/python tests/fixtures/documents/make_fixtures.py
"""
from pathlib import Path

import pymupdf as fitz
from docx import Document
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

OUT = Path(__file__).parent


def png_bytes():
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 8, 8), False)
    pix.clear_with(200)
    return pix.tobytes('png')


def add_hyperlink(paragraph, text, url):
    rid = paragraph.part.relate_to(url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
    link = OxmlElement('w:hyperlink')
    link.set(qn('r:id'), rid)
    run = OxmlElement('w:r')
    t = OxmlElement('w:t')
    t.text = text
    run.append(t)
    link.append(run)
    paragraph._p.append(link)


def course_docx():
    """Expected AA findings: 1.3.1 skipped heading, 1.1.1 missing alt, 2.4.4 'click here', 1.3.1 table headers."""
    doc = Document()
    doc.core_properties.title = 'ECE 30861 Syllabus'
    rpr = doc.styles['Normal'].element.get_or_add_rPr()
    lang = OxmlElement('w:lang')
    lang.set(qn('w:val'), 'en-US')
    rpr.append(lang)
    image = OUT / '_tmp.png'
    image.write_bytes(png_bytes())
    doc.add_heading('ECE 30861 Syllabus', level=1)
    doc.add_paragraph('Welcome to the course.')
    doc.add_heading('Grading', level=3)
    doc.add_picture(str(image))
    described = doc.add_picture(str(image))
    image.unlink()
    pictures = list(doc.element.body.iter(qn('wp:docPr')))
    for pic in pictures:  # python-docx may write an empty descr; remove it so the first image has no alt text.
        pic.attrib.pop('descr', None)
    pictures[1].set('descr', 'Bar chart of the grade distribution')
    table = doc.add_table(rows=3, cols=2)
    for r, row in enumerate([('Item', 'Weight'), ('Exams', '60%'), ('Labs', '40%')]):
        for c, value in enumerate(row):
            table.cell(r, c).text = value
    add_hyperlink(doc.add_paragraph('For the rubric, '), 'click here', 'https://example.edu/rubric')
    doc.save(OUT / 'course.docx')


def default_language_docx():
    """A Word file whose language is set only in document-wide run defaults."""
    doc = Document()
    doc.core_properties.title = 'Default language test'
    # This metadata field is not the language source the parser should use.
    doc.core_properties.language = 'fr-FR'
    doc.add_paragraph('This document uses the default run language.')
    defaults = doc.styles.element.find(qn('w:docDefaults'))
    run_default = defaults.find(qn('w:rPrDefault')) if defaults is not None else None
    if run_default is None:
        if defaults is None:
            defaults = OxmlElement('w:docDefaults')
        if defaults.getparent() is None:
            doc.styles.element.insert(0, defaults)
        run_default = OxmlElement('w:rPrDefault')
        defaults.append(run_default)
    run_props = run_default.find(qn('w:rPr'))
    if run_props is None:
        run_props = OxmlElement('w:rPr')
        run_default.append(run_props)
    lang = OxmlElement('w:lang')
    lang.set(qn('w:val'), 'en-US')
    run_props.append(lang)
    normal_rpr = doc.styles['Normal'].element.rPr
    if normal_rpr is not None:
        normal_lang = normal_rpr.find(qn('w:lang'))
        if normal_lang is not None:
            normal_rpr.remove(normal_lang)
    doc.save(OUT / 'default-language.docx')


def course_pdf():
    """Untagged. Expected AA findings: 1.3.1 untagged PDF, 2.4.4 'click here'."""
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), 'ECE 30861 Syllabus', fontsize=12)
    page.insert_text((72, 100), 'click here', fontsize=12)
    page.insert_link({'kind': fitz.LINK_URI, 'from': fitz.Rect(70, 88, 140, 104), 'uri': 'https://example.edu/rubric'})
    page.insert_image(fitz.Rect(72, 120, 140, 188), stream=png_bytes())
    doc.set_metadata({'title': 'ECE 30861 Syllabus'})
    doc.xref_set_key(doc.pdf_catalog(), 'Lang', '(en-US)')
    doc.save(OUT / 'course.pdf')
    doc.close()


def _write_pdf(path, objects):
    """Writes numbered PDF objects (object 1 is the catalog) with a valid cross-reference table."""
    out = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f'{number} 0 obj\n'.encode() + body + b'\nendobj\n'
    xref = len(out)
    out += f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode()
    out += b''.join(f'{o:010d} 00000 n \n'.encode() for o in offsets)
    out += f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info {len(objects)} 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
    path.write_bytes(bytes(out))


def _stream(content, extra=b''):
    return b'<< /Length %d %s>>\nstream\n' % (len(content), extra) + content + b'\nendstream'


def tagged_pdf():
    """A tagged two-page PDF, written by hand because PyMuPDF cannot create tags.

    Expected AA findings: 1.3.1 heading skip (H1 -> H3), 1.1.1 Figure 1 without /Alt,
    1.3.1 the page-2 table has no TH cells. Figure 2 has /Alt; table 1 has a THead row.
    The H1 uses a custom role, "Title1", mapped to H1 through the /RoleMap.
    """
    page1 = b"""/Title1 <</MCID 0>> BDC BT /F1 24 Tf 72 720 Td (Course Syllabus) Tj ET EMC
/H3 <</MCID 1>> BDC BT /F1 16 Tf 72 690 Td (Grading) Tj ET EMC
/P <</MCID 2>> BDC BT /F1 12 Tf 72 670 Td (Exams count for most of the grade.) Tj ET EMC
/Figure <</MCID 3>> BDC q 50 0 0 50 72 600 cm /Im1 Do Q EMC
/TH <</MCID 4>> BDC BT /F1 12 Tf 72 560 Td (Item) Tj ET EMC
/TD <</MCID 5>> BDC BT /F1 12 Tf 72 540 Td (Exams) Tj ET EMC"""
    page2 = b"""/Figure <</MCID 0>> BDC q 50 0 0 50 72 700 cm /Im1 Do Q EMC
/TD <</MCID 1>> BDC BT /F1 12 Tf 72 640 Td (Week) Tj ET EMC
/TD <</MCID 2>> BDC BT /F1 12 Tf 72 620 Td (One) Tj ET EMC"""
    resources = b'/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >>'
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 9 0 R /Lang (en-US) >>',
        b'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R ' + resources + b' /StructParents 0 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R ' + resources + b' /StructParents 1 >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        _stream(b'\xc8' * 12, b'/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 '),
        _stream(page1),
        _stream(page2),
        # 9: StructTreeRoot. ParentTree maps each page's MCIDs to their structure elements.
        b'<< /Type /StructTreeRoot /K [10 0 R] /RoleMap << /Title1 /H1 >> '
        b'/ParentTree << /Nums [0 [11 0 R 12 0 R 13 0 R 14 0 R 18 0 R 19 0 R] 1 [20 0 R 22 0 R 23 0 R]] >> >>',
        b'<< /Type /StructElem /S /Document /P 9 0 R /K [11 0 R 12 0 R 13 0 R 14 0 R 15 0 R 20 0 R 21 0 R] >>',
        b'<< /Type /StructElem /S /Title1 /P 10 0 R /Pg 3 0 R /K 0 >>',
        b'<< /Type /StructElem /S /H3 /P 10 0 R /Pg 3 0 R /K 1 >>',
        b'<< /Type /StructElem /S /P /P 10 0 R /Pg 3 0 R /K 2 >>',
        b'<< /Type /StructElem /S /Figure /P 10 0 R /Pg 3 0 R /K 3 >>',
        b'<< /Type /StructElem /S /Table /P 10 0 R /K [16 0 R 17 0 R] >>',
        b'<< /Type /StructElem /S /THead /P 15 0 R /K [24 0 R] >>',
        b'<< /Type /StructElem /S /TBody /P 15 0 R /K [25 0 R] >>',
        b'<< /Type /StructElem /S /TH /P 24 0 R /Pg 3 0 R /K 4 >>',
        b'<< /Type /StructElem /S /TD /P 25 0 R /Pg 3 0 R /K 5 >>',
        b'<< /Type /StructElem /S /Figure /P 10 0 R /Pg 4 0 R /K 0 /Alt (Bar chart of the grade distribution) >>',
        b'<< /Type /StructElem /S /Table /P 10 0 R /K [26 0 R 27 0 R] >>',
        b'<< /Type /StructElem /S /TD /P 26 0 R /Pg 4 0 R /K 1 >>',
        b'<< /Type /StructElem /S /TD /P 27 0 R /Pg 4 0 R /K 2 >>',
        b'<< /Type /StructElem /S /TR /P 16 0 R /K [18 0 R] >>',
        b'<< /Type /StructElem /S /TR /P 17 0 R /K [19 0 R] >>',
        b'<< /Type /StructElem /S /TR /P 21 0 R /K [22 0 R] >>',
        b'<< /Type /StructElem /S /TR /P 21 0 R /K [23 0 R] >>',
        b'<< /Title (ECE 30861 Syllabus) >>',
    ]
    _write_pdf(OUT / 'tagged.pdf', objects)


def pdf_review_fixtures():
    # A raster-only page and a text/raster mix. Render the source page before insertion
    # so the scan has no embedded text even though its visible words are legible.
    with fitz.open() as source, fitz.open() as mixed:
        page = source.new_page(width=380, height=290)
        page.insert_text((36, 68), 'Course schedule', fontsize=22)
        page.insert_text((36, 103), 'Read chapter one before lab.', fontsize=14)
        image = page.get_pixmap(matrix=fitz.Matrix(2, 2))
        mixed.new_page(width=380, height=290).insert_text((36, 68), 'Native digital text')
        scanned = mixed.new_page(width=380, height=290)
        scanned.insert_image(scanned.rect, pixmap=image)
        mixed.set_metadata({'title':'Scanned syllabus'})
        mixed.xref_set_key(mixed.pdf_catalog(), 'Lang', '(en-US)')
        mixed.save(OUT / 'mixed-scan.pdf', deflate=True, no_new_id=True)

    with fitz.open() as doc:
        page = doc.new_page(width=400, height=280)
        page.insert_text((40, 56), 'Enrollment form', fontsize=18)
        for index, tooltip in enumerate(['Student name', '']):
            widget = fitz.Widget()
            widget.field_type = fitz.PDF_WIDGET_TYPE_TEXT
            widget.field_name = f'field_{index}'
            widget.field_label = tooltip
            widget.rect = fitz.Rect(40, 84 + index * 56, 250, 115 + index * 56)
            page.add_widget(widget)
        doc.set_metadata({'title':'Enrollment form'})
        doc.xref_set_key(doc.pdf_catalog(), 'Lang', '(en-US)')
        doc.save(OUT / 'pdf-fields.pdf', no_new_id=True)

    # Identical page content, with two orders for the logical tag tree.
    positions = [(48, 700, 'Left column first'), (48, 650, 'Left column second'),
                 (320, 700, 'Right column first'), (320, 650, 'Right column second')]
    stream = b'\n'.join(f'/P <</MCID {i}>> BDC BT /F1 12 Tf {x} {y} Td ({label}) Tj ET EMC'.encode()
                         for i, (x, y, label) in enumerate(positions))
    for name, sequence in [('reading-order-correct.pdf', '8 0 R 9 0 R 10 0 R 11 0 R'),
                           ('reading-order-mismatch.pdf', '8 0 R 10 0 R 9 0 R 11 0 R')]:
        _write_pdf(OUT / name, [
            b'<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 6 0 R /Lang (en-US) >>',
            b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R '
            b'/Resources << /Font << /F1 4 0 R >> >> /StructParents 0 >>',
            b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
            _stream(stream),
            b'<< /Type /StructTreeRoot /K [7 0 R] /ParentTree << /Nums [0 [8 0 R 9 0 R 10 0 R 11 0 R]] >> >>',
            f'<< /Type /StructElem /S /Document /P 6 0 R /K [{sequence}] >>'.encode(),
            *(f'<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K {i} >>'.encode() for i in range(4)),
            b'<< /Title (Two-column handout) >>',
        ])


def encrypted_pdf():
    doc = fitz.open()
    doc.new_page().insert_text((72, 72), 'Secret', fontsize=12)
    doc.save(OUT / 'encrypted.pdf', encryption=fitz.PDF_ENCRYPT_AES_256, user_pw='secret', owner_pw='owner')
    doc.close()


if __name__ == '__main__':
    course_docx()
    default_language_docx()
    course_pdf()
    tagged_pdf()
    pdf_review_fixtures()
    encrypted_pdf()
    (OUT / 'corrupt.docx').write_bytes(b'PK\x03\x04' + b'\x00not a real zip archive' * 4)
    (OUT / 'notes.txt').write_text('Week 1 notes\nRead chapter one before lab.\n')
    print('Fixtures written to', OUT)
