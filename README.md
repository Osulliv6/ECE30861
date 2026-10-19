# ECE 30861 Group ADA Project

This is a runnable Phase 3 system: choose an HTML, PDF, DOCX, or plain-text document, submit it for accessibility analysis, and display the findings. The Node server validates the upload (size, type, and that the content really is that format), passes it to Prathum's Python parser (`accessibility-parser/`), runs the WCAG engine (`engine/`) on the parsed structure, and returns the shared JSON report. Each upload is written to a private temporary directory only for the parser run and is deleted afterwards, whether parsing succeeds or fails.

## Run locally

Requires Node.js 18 or newer (no npm dependencies) and Python 3.10 or newer for the parser. Create the parser's virtual environment once:

```sh
python3 -m venv accessibility-parser/.venv
accessibility-parser/.venv/bin/pip install -r accessibility-parser/requirements.txt
npm start
```

The server uses `accessibility-parser/.venv` automatically when it exists. Otherwise, set `PYTHON` to an interpreter with the parser's packages installed. If no working parser is available, `/analyze` returns HTTP 503.

Open http://127.0.0.1:3086. The same service serves the UI and API, so no connection dialog is needed locally. Use **View a sample report** or **View a no-issue example** to inspect the interface without uploading a document; these are fixed examples and never analyze a selected document.

Uploaded documents are sent only after the user clicks **Check accessibility**. The server exposes `GET /health`, `GET /formats`, and `POST /analyze`, and returns structured errors for invalid requests.

## Connect a separately hosted service

For a separate deployment, click **Connect service** and enter its HTTPS base URL, or set `API_BASE_URL` in `frontend/config.js`. HTTP is accepted only for loopback development URLs. The base URL may include an API prefix, for example `https://example.edu/api`.

Alternatively, serve the contents of `frontend/` from the team's backend and leave `API_BASE_URL` empty for same-origin requests. Keep the JavaScript MIME type correct and use HTTPS in deployment. If the frontend and backend use separate origins, the backend must allow the frontend's origin through CORS. Authentication is not used by the shared Phase 2 contract; the client omits credentials and contains no AI-provider keys.

The target repository is [Osulliv6/ECE30861](https://github.com/Osulliv6/ECE30861).

## Deploy

The `Dockerfile` builds one container holding the UI, API, engine, and parser (Node 22 and Python 3.11). Any container host that provides HTTPS works, for example Render, Railway, or Fly.io: point it at this repository and choose the Dockerfile. The container listens on `0.0.0.0:$PORT`, using port 8080 when the host does not set `PORT`. Because the UI and API share one origin, no CORS settings are required. If the frontend is hosted elsewhere, set `CORS_ORIGINS` to a comma-separated list of allowed origins.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | 3086 locally, 8080 in Docker | Listening port |
| `HOST` | `127.0.0.1` locally, `0.0.0.0` in Docker | Listening address |
| `PYTHON` | `accessibility-parser/.venv/bin/python`, then `python3` | Parser interpreter |
| `CORS_ORIGINS` | the local preview origins | Extra allowed browser origins |

**Logs:** The server writes one JSON line per request to standard output, which appears in the hosting platform's log view (the Render dashboard's **Logs** tab). Each line records the time, method, path, status, and duration, plus the error code or source and detail for failures. Tester runs add a count of pass, fail, error, and skip outcomes. Successful `/health` checks and static UI files aren't logged, and uploaded file names and contents are never logged. The startup line records the deployed commit (`RENDER_GIT_COMMIT`). Search for `"status":5` to find server failures, or `"error_code"` to find rejected uploads.

After each deployment, run `./scripts/smoke-test.sh https://<your-service>`. It checks `/health`, `/formats`, the UI, real DOCX and PDF analysis, and a tester run against the service's own system.

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

The DOCX's Section 5.2 supplies the more precise severity and location fields; it notes these need pod confirmation. Keep `parseReport()` in `frontend/core.js` aligned if the pod adopts different fields. This phase supports `text/html` only; `/formats` is the authoritative discovery endpoint. The service rejects empty, malformed, non-UTF-8, and non-document HTML, does not trust browser filenames, and enforces a 10 MB decimal limit. PDF and Word support are intentionally deferred until a parser is added and tested.

Error responses should use `{"error":{"code":"UNPROCESSABLE_FILE","message":"The file could not be evaluated."}}`. The frontend also accepts a top-level `{code,message}` error on a non-success HTTP status, accommodating the example in the supplied documents.

| HTTP status | Meaning |
| --- | --- |
| 400 | Missing or malformed request |
| 413 | File exceeds the service size limit |
| 415 | Unsupported file type |
| 422 | Empty, corrupt, or unreadable document |
| 503 | Internal or required external service unavailable |

The client does not set `Content-Type` for multipart uploads; the browser supplies the boundary. It does not silently retry document uploads. Analysis stops waiting after 30 seconds and displays a failure, without showing an old or incomplete report. HTTP 202 is displayed as processing without a completed report. No polling endpoint or job token is specified in Phase 2, so automatic polling is not invented. If the backend supports asynchronous evaluation later, the pod must define how the client retrieves the final report.

## Cross-team testing interface

The course's cross-team testing spec requires each team to deploy a **system** and a **tester**. Both run in this one service, at different base URLs:

| Registry field | Value |
| --- | --- |
| System base URL | `https://ece30861-ada.onrender.com` |
| Tester base URL | `https://ece30861-ada.onrender.com/tester` |
| Access / run notes | No authentication. Maximum times: system setup 70 s (the free hosting plan can take up to 60 s to wake); tester setup 70 s (including target setup); tester run 15 minutes (13 target calls, each with a 60 s limit, plus coverage retrieval). |

**System** (`testing/system.mjs`):
- `POST /test/setup` accepts `{"session_id":"…","setup":{}}` and returns 201 with the same ID. It returns 409 for a duplicate ID and 400 for an invalid body.
- `GET /test/report?session_id=…` returns code coverage (200), or 404 for an unknown session.
- The project API is stateless, so setup only registers the session. Line coverage isn't instrumented in the deployed service, so `covered` and `total` are `null` and `basis` explains why, as the spec allows.

**Tester** (`testing/tester.mjs`):
- `POST /tester/test/setup` with `{"target_url":"https://other-team.example/system"}` creates a session (UUID), calls the target's `/test/setup`, and returns 201 when the target is ready. It forwards the target's error status, message, and source.
- `POST /tester/test/run` with `{"session_id":"…"}` runs tests T-01 to T-13 in order against the target's `/health`, `/formats`, and `/analyze`. It returns one report with a `pass`, `fail`, `error` (with `source`), or `skip` outcome per test, plus code, component, and system coverage.
- `GET /tester/test/report?session_id=…` returns the stored report, or 409 before the suite ends.
- A session runs only once. Running it again returns 409.

The suite checks:
- health and formats
- missing alt text (HTML and DOCX)
- contrast at level AA, and its exclusion at level A
- the no-issue report
- PDF analysis
- expected errors: unsupported type (415), empty file (422), corrupt DOCX (422), missing file (400), and invalid `wcag_level` (400)

DOCX and PDF tests are skipped when the target's `/formats` doesn't list that format.

Component and system coverage count the components and acceptance criteria listed in the pod specification. Until the pod lists are added to `testing/pod-spec.json`, both are reported as `null` with an explanation. To fill them in, map each pod item ID to the tests that exercise it, for example `"items": {"AC-01": ["T-03", "T-07"]}`.

Both services are described in `openapi/system.yaml` and `openapi/tester.yaml`. CI validates both files on every push. The smoke test also runs the tester against the service's own system.

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

`server.mjs` returns `report` unchanged with HTTP 200. `analyze` throws `EngineError`: code `INVALID_PARSED_DOCUMENT` means the parser produced invalid output, and code `INVALID_WCAG_LEVEL` means the request had a bad `wcag_level`. The backend should map these errors to its own error response, for example 503/500 or 400. To try the engine from the command line, run `node engine/cli.mjs tests/fixtures/parsed/syllabus.json [A|AA]`.

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

`metadata.not_extracted` lists things the parser could not observe for this format. The engine skips the matching checks so that "unknown" is never reported as "missing". The values are `alt_text`, `headings`, `tables`, `title`, and `language`. The parser sends `["alt_text","headings","tables"]` for PDF, because it does not read tagged-PDF semantics. For plain text it sends all five values, because plain text cannot contain any of these.

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

`tests/core.test.mjs` covers URL restrictions, discovered formats, file-type and size boundaries, complete/partial report validation, multipart field preservation, HTTP errors, pending responses, timeout, and cancellation. `tests/engine.test.mjs` covers each engine check, contrast math against WCAG reference values, A/AA filtering, rejection of invalid parser output, and that every engine report passes the frontend's `parseReport()`. `tests/backend.test.mjs` starts the actual local service on an ephemeral loopback port and verifies health, format discovery, CORS, UI serving, successful HTML analysis, WCAG-level filtering, and malformed/unsupported upload responses. `tests/integration.test.mjs` runs end to end through the Python parser. It uploads real DOCX, PDF, and TXT files from `tests/fixtures/documents/` and checks that each report contains the expected findings and passes `parseReport()`. It also covers MIME fallback by file extension, corrupt, encrypted, mismatched, and non-UTF-8 files (422), temp-file deletion, a missing or hung parser (503), oversized and malformed uploads, CORS preflight, and path-traversal attempts.

`tests/test-interface.test.mjs` covers the cross-team testing endpoints. It checks system setup and report (201, 409, 400, 404); a full tester run against this system in which all 13 tests pass and the stored report stays unchanged; forwarding of target setup failures; unreachable targets (source `communication`); and per-test outcomes when a fake target times out, returns 500, sends an invalid report, or doesn't support DOCX or PDF.

Parser tests run separately: `cd accessibility-parser && .venv/bin/python -m pytest -q`. To regenerate the document fixtures, run `accessibility-parser/.venv/bin/python tests/fixtures/documents/make_fixtures.py`. GitHub Actions (`.github/workflows/test.yml`) runs both test suites on every push, then builds the Docker image and runs the smoke test against it.

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

PDF analysis is partial: alt text, headings, and tables in tagged PDFs are not read, so those checks are skipped for PDFs instead of guessed. Contrast checks use only inline or run-level colors, not external CSS or rendered backgrounds. The UI itself has not been certified for WCAG conformance; keyboard support and visual checks are implementation evidence, not a full assistive-technology audit.

## Files

- `frontend/index.html`: semantic markup and application structure
- `frontend/styles.css`: responsive visual design and interaction states
- `frontend/app.js`: UI state, upload workflow, connection dialog, report rendering, and downloads
- `frontend/core.js`: API client, validation, response parsing, and error handling
- `frontend/config.js`: backend URL and analysis timeout
- `frontend/samples.js`: fixed demonstration reports
- `engine/`: accessibility analysis / WCAG engine (`index.mjs` entry point, `checks.mjs` rules, `contrast.mjs` color math, `cli.mjs`)
- `server.mjs`: API (upload validation, content-type checks, error mapping), CORS handling, and static UI server
- `accessibility-parser/`: Prathum's Python document parser; `integration.mjs` is the Node bridge (temp file, timeout, cleanup)
- `testing/`: cross-team testing interface (`system.mjs`, `tester.mjs` and its suite, `pod-spec.json` for coverage)
- `openapi/`: OpenAPI 3.1 descriptions of the system and tester
- `Dockerfile`, `scripts/smoke-test.sh`, `.github/workflows/test.yml`: deployment, post-deploy check, and CI
- `tests/`: automated tests, synthetic fixtures, and test service
- `UI_HANDOFF.md`: requirements mapping and engineering handoff

## AI contribution

Codex generated the frontend implementation, examples, tests, and handoff documentation from the four supplied phase documents. Generated output was checked with automated tests and browser interaction/visual checks. This records the assistance used; it does not imply that teammates or instructors have reviewed or approved the work.
