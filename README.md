# ECE 30861 Group ADA Project

Aarnav's Phase 3 UI portion: choose a document, submit it for accessibility analysis, and display the findings. The frontend follows the Phase 2 common HTTP interface and carries forward the faculty/content-creator audience and human-review boundary from Phase 1. Phase 3 assigns the frontend to Aarnav with an October 14 deadline.

## Run locally

Requires Node.js 18 or newer. There are no npm dependencies to install.

```sh
npm start
```

Open http://127.0.0.1:3086. Use **View a sample report** or **View a no-issue example** to inspect the interface without a backend. These are fixed examples, clearly labeled, and never analyze a selected document.

The standalone preview server serves frontend files only. It is not the team's analysis backend. Uploaded documents are sent only after the user clicks **Check accessibility**.

## Connect the team backend

Click **Connect service** and enter Gabriel's HTTPS service base URL, or set `API_BASE_URL` in `frontend/config.js`. HTTP is accepted only for loopback development URLs. The base URL may include an API prefix, for example `https://example.edu/api`.

Alternatively, serve the contents of `frontend/` from the team's backend and leave `API_BASE_URL` empty for same-origin requests. Keep the JavaScript MIME type correct and use HTTPS in deployment. If the frontend and backend use separate origins, the backend must allow the frontend's origin through CORS. Authentication is not used by the shared Phase 2 contract; the client omits credentials and contains no AI-provider keys.

The target repository is [Osulliv6/ECE30861](https://github.com/Osulliv6/ECE30861). It contained no commits before this frontend was prepared. The backend implementation, deployment URL, actual format support, and CORS behavior have not yet been verified.

### Required endpoints

| Endpoint | Frontend behavior | Expected response |
| --- | --- | --- |
| `GET /health` | Checks the connection | HTTP 200, `{"status":"ok"}` |
| `GET /formats` | Sets file-picker types and upload limit | HTTP 200, nonempty `supported_mime_types` array and numeric `max_file_size_mb` of at least 10 |
| `POST /analyze` | Sends one document for analysis | Multipart `file` and `wcag_level` (`A` or `AA`, default `AA`); successful JSON with `issues` array |

An example **complete** successful response:

```json
{
  "issues": [
    {
      "wcag_criterion": "1.1.1",
      "location": {"page": 2, "snippet": "Figure 1"},
      "severity": "serious",
      "description": "An informative image is missing alternative text.",
      "suggested_fix": "Add alternative text explaining the image's purpose."
    }
  ]
}
```

Each issue requires `wcag_criterion`, `location`, `severity`, `description`, and `suggested_fix`. Location may be `null` or an object containing one or more of `selector`, `line`, `page`, and `snippet`. Line and page values are positive integers. Severity is `critical`, `serious`, `moderate`, or `minor`. A no-issue result is `{"issues":[],"message":"No supported violations were detected. This does not certify full ADA or WCAG compliance."}`. Empty-issue reports must include a nonempty message. The UI displays its own explicit no-issue statement and scope limitation; the backend must also return the required statement and limitation.

The DOCX's Section 5.2 supplies the more precise severity and location fields; it notes these need pod confirmation. Keep `parseReport()` in `frontend/core.js` aligned if the pod adopts different fields. Supported formats remain unresolved in the supplied reports, so the frontend discovers them rather than promising PDF, Word, or other support. Browser MIME types and extensions are only client hints; backend content validation is authoritative.

Error responses should use `{"error":{"code":"UNPROCESSABLE_FILE","message":"The file could not be evaluated."}}`. The frontend also accepts a top-level `{code,message}` error on a non-success HTTP status, accommodating the example in the supplied documents.

| HTTP status | Meaning |
| --- | --- |
| 400 | Missing or malformed request |
| 413 | File exceeds the service size limit |
| 415 | Unsupported file type |
| 422 | Empty, corrupt, or unreadable document |
| 503 | Internal or required external service unavailable |

The client does not set `Content-Type` for multipart uploads; the browser supplies the boundary. It does not silently retry document uploads. Analysis stops waiting after 30 seconds and displays a failure, without showing an old or incomplete report. HTTP 202 is displayed as processing without a completed report. No polling endpoint or job token is specified in Phase 2, so automatic polling is not invented. If the backend supports asynchronous evaluation later, the pod must define how the client retrieves the final report.

## Interface behavior

- Browse for one file or drag and drop it; inspect its name and size, or remove it.
- Reject empty, oversized, and unsupported selections before upload. Size uses decimal megabytes (`1 MB = 1,000,000 bytes`); align the backend if the pod chooses another convention.
- Choose WCAG 2.1 A or AA, with AA selected initially.
- Show a waiting indicator and elapsed seconds. Cancel the browser request without claiming that server-side processing has stopped.
- Display complete findings with criterion, severity, available location, description, and suggested fix. Filter by severity.
- Explicitly show no supported violations for an empty issues array and retain the compliance limitation.
- Download the current report as JSON. Downloads preserve the server report fields and add `frontend_context` identifying the document, level, and whether the report is a sample.
- Use semantic HTML, native controls, keyboard focus indicators, a skip link, live announcements, dialog focus handling, responsive layout, and reduced-motion support.

There is no automatic document editing, compliance score, account system, report history, or document preview. The backend owns parsing, WCAG detection, remediation generation, file integrity checking, and uploaded-file deletion. The frontend stores no uploads or reports in localStorage, cookies, or a database. Completed uploads are released from frontend state; current results exist only in page memory until replaced or the page closes. Downloading JSON is an explicit user action and creates a local copy.

## Accessibility engine

Kathleen's Phase 3 component lives in `engine/`. It takes the parser's output, checks it against the WCAG 2.1 criteria below, and returns the report JSON that `POST /analyze` sends to the frontend. It has no dependencies and does not read files or make network calls.

```js
import { analyze, EngineError } from './engine/index.mjs';
const report = analyze(parsedDocument, { wcagLevel: 'AA' }); // {issues:[...]} or {issues:[], message}
```

The backend should return `report` unchanged with HTTP 200. `analyze` throws `EngineError`: code `INVALID_PARSED_DOCUMENT` means the parser produced invalid output, and code `INVALID_WCAG_LEVEL` means the request had a bad `wcag_level`. The backend should map these errors to its own error response, for example 503/500 or 400. To try the engine from the command line, run `node engine/cli.mjs tests/fixtures/parsed/syllabus.json [A|AA]`.

### Supported checks

| Criterion | Level | Check | Severity |
| --- | --- | --- | --- |
| 1.1.1 Non-text Content | A | Image has no alt text | serious |
| | | Alt text is a file name or placeholder ("image", `IMG_0042.png`) | serious |
| | | Alt text starts with "image of" / "picture of" | minor |
| | | Alt text is longer than 150 characters | minor |
| 1.3.1 Info and Relationships | A | Heading levels skip (H1 → H3) | moderate |
| | | First heading is not H1 | minor |
| | | 1,500+ characters of text and no headings | moderate |
| | | Large or bold standalone text that looks like an unmarked heading | moderate |
| | | Data table has no header row or column | moderate |
| 1.4.3 Contrast (Minimum) | AA | Below 4.5:1 for normal text or 3:1 for large text (18pt+, or 14pt+ bold) | serious if far below the threshold, otherwise moderate |
| 2.4.2 Page Titled | A | Document title property is missing | moderate |
| 2.4.4 Link Purpose | A | Link text is empty / generic ("click here", "read more") / a raw URL | serious / moderate / minor |
| 2.4.6 Headings and Labels | AA | Heading is empty | serious |
| 3.1.1 Language of Page | A | Document language is missing or invalid | moderate |

With `wcagLevel: 'A'`, the report omits the AA criteria (1.4.3 and 2.4.6). Images with `alt: ""` or `decorative: true` are treated as decorative. The engine skips colors it cannot parse instead of guessing. If an element has `color` but no `background`, the engine assumes a white background. Findings are sorted by page and then line, with document-level findings first.

### Parsed document input (contract with the parser)

The `elements` array is in reading order. Only `type` is required; the engine uses any other fields that are present. It ignores unknown element types and fields, so the parser can send more data than the engine uses.

```json
{
  "metadata": {"title": "ECE 30861 Syllabus", "language": "en-US"},
  "elements": [
    {"type": "heading", "level": 1, "text": "Syllabus", "location": {"page": 1}},
    {"type": "text", "text": "Course Policies", "bold": true, "standalone": true, "font_size_pt": 12, "color": "#999999", "background": "#ffffff"},
    {"type": "image", "alt": null, "decorative": false, "src": "fig1.png", "caption": "Figure 1"},
    {"type": "link", "text": "click here", "href": "https://example.edu"},
    {"type": "table", "rows": 5, "has_header_row": false, "has_header_column": false, "layout": false, "caption": "Grades"}
  ]
}
```

| Field | Meaning |
| --- | --- |
| `heading.level` | Required integer from 1 to 6 |
| `image.alt` | `null` or missing means no alt text; `""` means decorative |
| `text.standalone` | `true` when the text is its own paragraph or line; used to detect bold "fake headings" |
| `color`, `background` | `#rgb`, `#rrggbb`, `rgb(r,g,b)`, `{r,g,b}`, or a basic CSS color name; allowed on any text-bearing element |
| `font_size_pt`, `bold` | Used to decide whether text is large for contrast purposes |
| `table.layout` | `true` excludes layout-only tables from the header check |
| `location` | Optional `{page, line, selector}`; invalid values are dropped. The engine adds a `snippet` from the element text |

## Verification

```sh
npm test
```

`tests/core.test.mjs` (7 tests) covers URL restrictions, discovered formats, file-type and size boundaries, complete/partial report validation, multipart field preservation, HTTP errors, pending responses, timeout, and cancellation. `tests/engine.test.mjs` (7 tests) covers each engine check, contrast math against WCAG reference values, A/AA filtering, rejection of invalid parser output, and that every engine report passes the frontend's `parseReport()`. Tests do not require a backend.

A deterministic local test service is supplied for UI integration checks:

```sh
node tests/mock-service.mjs
```

Connect the preview to `http://127.0.0.1:3087`. **This is a test double, not an accessibility analyzer.** All fixture files are synthetic. Filename-based responses allow reproducible frontend checks:

| Fixture in `tests/fixtures/` | Behavior |
| --- | --- |
| `findings.html` | Complete report with three example findings |
| `clean.html` | No-issue response |
| `corrupt.html` | HTTP 422 |
| `unavailable.html` | HTTP 503 |
| `partial.html` | Invalid incomplete report |
| `slow.html` | Response delayed beyond the client's 30-second limit |
| `empty.html` | Client rejects zero bytes |
| `unsupported.exe` | Client rejects unsupported type |

Actual document analysis, backend cleanup, HTTPS deployment, and AI suggestion quality require the real team service. The UI itself has not been certified for WCAG conformance; keyboard support and visual checks are implementation evidence, not a full assistive-technology audit.

## Files

- `frontend/index.html`: semantic markup and application structure
- `frontend/styles.css`: responsive visual design and interaction states
- `frontend/app.js`: UI state, upload workflow, connection dialog, report rendering, and downloads
- `frontend/core.js`: API client, validation, response parsing, and error handling
- `frontend/config.js`: backend URL and analysis timeout
- `frontend/samples.js`: fixed demonstration reports
- `engine/`: accessibility analysis / WCAG engine (`index.mjs` entry point, `checks.mjs` rules, `contrast.mjs` color math, `cli.mjs`)
- `server.mjs`: local static preview server
- `tests/`: automated tests, synthetic fixtures, and test service
- `UI_HANDOFF.md`: requirements mapping and engineering handoff

## AI contribution

Codex generated the frontend implementation, examples, tests, and handoff documentation from the four supplied phase documents. Generated output was checked with automated tests and browser interaction/visual checks. This records the assistance used; it does not imply that teammates or instructors have reviewed or approved the work.
