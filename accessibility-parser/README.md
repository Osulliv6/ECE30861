# Prathum's document parser — ECE 30861 accessibility project

This is **the document processing/parsing module**, not the backend, WCAG engine, or UI. It converts supported documents into the JSON structure consumed by Kathleen's `engine/index.mjs` (`analyze(parsedDocument, {wcagLevel:'AA'})`).

## Supported formats

- **DOCX:** paragraphs, built-in Heading 1–6 styles, image descriptions, tables, explicit table headers, hyperlinks, title/author, default language (when available), approximate body order, basic font styling.
- **HTML:** DOM-order headings/text/images/links/tables, alt text, document title and language, inline CSS colors and font sizes; external stylesheets are not evaluated.
- **PDF:** page-ordered text/images and URI links, basic text color/font size/bold, PDF metadata. **Important:** native PDF heading, table, and alt-text semantics are not reliably extracted. PDF output is a *partial* structural analysis, not a complete PDF accessibility audit.
- **TXT:** lines of text only; no metadata, styling, heading semantics, or embedded images.

These choices are an implementation proposal. Confirm supported format claims with the team before `/formats` advertises them. The backend must enforce file size, content-type/magic-byte checks, cleanup, and upload security (not done in this parser).

## Install and run

Requires Python 3.10+ and the packages listed in `requirements.txt`.

```bash
python3 -m pip install -r requirements.txt
python3 -m parser.cli path/to/sample.docx
python3 -m pytest -q
```

The CLI prints a single JSON object. A failure prints `{"error":{"code":"...","message":"..."}}` and exits nonzero. It is important that the backend **never** return `parser_info` as an accessibility certification.

## Integration in the group repo

`server.mjs` calls `parseUpload(bytes, extension)` from `integration.mjs`. That function writes the validated upload to a private temporary directory, runs `python -m parser.cli` from this folder with a 25-second timeout, and deletes the directory in a `finally` block. Parser errors map to HTTP 422 (unreadable document) or 415 (unsupported type). A missing, crashing, or timed-out parser maps to 503. Create the virtual environment at `accessibility-parser/.venv`, which the server finds automatically, or set `PYTHON`.

The CLI redirects library output to stderr while parsing, so stdout contains only the JSON result. PyMuPDF 1.28 prints a deprecation warning to stdout when `fitz` is imported, which would otherwise break the JSON output, so the parser imports `pymupdf`.

Example shape passed to the engine:

```json
{
  "metadata":{"title":"Syllabus","language":"en-US","format":"docx"},
  "elements":[
    {"type":"heading","level":1,"text":"Syllabus","location":{"line":1}},
    {"type":"image","alt":null,"decorative":false,"src":"Picture 1","location":{"line":2}},
    {"type":"table","rows":3,"has_header_row":false,"has_header_column":false,"layout":false,"location":{"line":3}}
  ],
  "parser_info":{"format":"docx","reading_order":"...","limitations":[]}
}
```

## Boundaries and known limitations

- `location.line` for DOCX means **body element sequence**, not an actual visual line. Page positions cannot be extracted without rendering. HTML `line` is **element visitation order**, not source-code line.
- DOCX detects table headers only where Word explicitly marks header rows. It will not assume first-row text is a semantic header.
- DOCX complex text-boxes, floating images, equations, headers/footers, comments, and some drawings aren't fully covered.
- PDF is intentionally conservative: untagged lines aren't assigned fake heading levels; scanned PDFs need separate OCR and tagging analysis. PDF and TXT output sets `metadata.not_extracted` (for example `["alt_text","headings","tables"]` for PDF). The engine then skips those checks instead of reporting unknown values as missing.
- Basic inline style extraction is not computed CSS; do not treat it as complete contrast inspection.
- No file is uploaded to third parties. No LLM API is called.

## Implementation ownership

Prathum: `parser/`, tests, format coverage, and parser-engine handoff. Kathleen: WCAG rules/report. Gabriel: upload validation/server/runtime and endpoint deployment. Aarnav: frontend/report display.
