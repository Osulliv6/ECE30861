# ECE 30861 Group ADA Project

This is a runnable Phase 4 system: choose an HTML, PDF, DOCX, or plain-text document, submit it for accessibility analysis, and display the findings. It can also repair the problems that have a safe automatic fix and return a repaired copy (see [Remediation](#remediation)). What changed in this phase is in [Phase 4 changes](#phase-4-changes). The Node server validates the upload (size, type, and that the content really is that format), passes it to Prathum's Python parser (`accessibility-parser/`), runs the WCAG engine (`engine/`) on the parsed structure, and returns the shared JSON report. Each upload is written to a private temporary directory only for the parser run and is deleted afterwards, whether parsing succeeds or fails.

## Phase report and deployment status

The Phase 4 report records a deployed and tested snapshot at commit `6fc234f` (October 18, 2026). For that snapshot, our deployed tester passed 13/13 tests, and a podmate's tester passed all 15 tests it executed against our service. The podmate's test confirmed a 10 MiB file completed within 30 seconds. The report also notes that our own suite did not yet include an automated timing check, and that a cold start on Render's free plan can take up to 60 seconds. These results describe the reported deployment snapshot; they do not by themselves verify later repository changes or the current live deployment.

The report marked accessibility detection, remediation guidance, processing-failure handling, and response-time verification as partial. Its known gaps at that snapshot included no AI-generated suggestions or human-rubric review of guidance; incomplete tagged-PDF semantic extraction and contrast checks limited to inline colors; unavailable measured code, component, and acceptance-criteria coverage; and the implementation-specific `MALFORMED_REQUEST` and `PROCESSING_TIMEOUT` error codes. The implementation sections below describe the repository source and its later Phase 4 work. Check the deployed commit before treating those later source changes as live-service behavior.

## Testing our deployed service (for podmates)

| What | URL |
| --- | --- |
| **System base URL** (use this as `target_url`) | `https://ece30861-ada.onrender.com` |
| **Tester base URL** (our automated test runner) | `https://ece30861-ada.onrender.com/tester` |
| Web UI | https://ece30861-ada.onrender.com |

Notes:
- No authentication.
- The project API is stateless, so project requests don't carry a session ID.
- The service is on a free hosting plan that sleeps after about 15 minutes idle. The first request after that can take up to 60 seconds. Allow at least 70 seconds for setup.

### System endpoints

| Method and URL | Purpose | Request | Success response |
| --- | --- | --- | --- |
| `GET https://ece30861-ada.onrender.com/health` | Health check | none | `200 {"status":"ok"}` |
| `GET https://ece30861-ada.onrender.com/formats` | Supported formats and size limit | none | `200 {"supported_mime_types":[...],"max_file_size_mb":10}` |
| `POST https://ece30861-ada.onrender.com/analyze` | Analyze one document | `multipart/form-data`: `file` (required), `wcag_level` = `A` or `AA` (optional, default `AA`) | `200 {"issues":[...]}` (plus a `message` when `issues` is empty) |
| `POST https://ece30861-ada.onrender.com/remediate` | Repair a document (team extension, not in the shared pod contract) | As `/analyze`, plus optional `language` (BCP 47 tag) and `title` | `200 {"remediated_file":{...},"changes":[...],"issues_before":[...],"issues_after":[...],"message":"..."}` |
| `POST https://ece30861-ada.onrender.com/test/setup` | Register a test session | JSON `{"session_id":"<unique id>","setup":{}}` | `201 {"session_id":"<same id>"}` |
| `GET https://ece30861-ada.onrender.com/test/report?session_id=<id>` | Code coverage for a session | none | `200 {"session_id":"<id>","coverage":{"code":{"covered":null,"total":null,"basis":"..."}}}` |

Supported formats are HTML, PDF, DOCX, and plain text, up to 10 MiB (10 × 1,048,576 bytes). The API field remains named `max_file_size_mb` for the shared interface.

`/analyze` and `/remediate` errors (`/remediate` also returns 400 `INVALID_LANGUAGE` and `INVALID_TITLE`):

| Status | Code | When |
| --- | --- | --- |
| 400 | `MISSING_FILE`, `INVALID_WCAG_LEVEL`, `MALFORMED_REQUEST` | Missing file, `wcag_level` other than `A`/`AA`, or an unreadable request |
| 413 | `FILE_TOO_LARGE` | File over 10 MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Unsupported file type |
| 422 | `UNPROCESSABLE_FILE` | Empty, corrupt, or mismatched file |
| 503 | `PROCESSING_UNAVAILABLE`, `PROCESSING_TIMEOUT` | Parser unavailable or timed out |

Project API errors use the Phase 2 contract shape `{"code":"...","message":"..."}`. Test endpoint errors use `{"message":"...","source":"system"}`, as the cross-team spec requires: 400 for invalid requests, 404 for unknown sessions, and 409 for a duplicate session ID.

### Quick checks with curl

```sh
curl https://ece30861-ada.onrender.com/health
curl https://ece30861-ada.onrender.com/formats
curl -F "file=@sample.html;type=text/html" -F wcag_level=AA https://ece30861-ada.onrender.com/analyze
curl -X POST -H "Content-Type: application/json" -d '{"session_id":"my-unique-id","setup":{}}' https://ece30861-ada.onrender.com/test/setup
curl "https://ece30861-ada.onrender.com/test/report?session_id=my-unique-id"
```

### Run your tester against our system

Call your own tester's setup with our system base URL as the target, then run it:

```sh
curl -X POST -H "Content-Type: application/json" -d '{"target_url":"https://ece30861-ada.onrender.com"}' https://<your-tester-base-url>/test/setup
curl -X POST -H "Content-Type: application/json" -d '{"session_id":"<id from setup>"}' https://<your-tester-base-url>/test/run
```

### Run our tester against your system

```sh
curl -X POST -H "Content-Type: application/json" -d '{"target_url":"https://<your-system-base-url>"}' https://ece30861-ada.onrender.com/tester/test/setup
curl -X POST -H "Content-Type: application/json" -d '{"session_id":"<id from setup>"}' https://ece30861-ada.onrender.com/tester/test/run
curl "https://ece30861-ada.onrender.com/tester/test/report?session_id=<id from setup>"
```

Our tester runs 15 tests (T-01 to T-15) against your `/health`, `/formats`, and `/analyze`, and returns one report with a pass, fail, error, or skip outcome per test, plus coverage. DOCX and PDF tests are skipped if your `/formats` doesn't list those formats. A run takes under a minute against an awake service. The full test list is in `testing/tester.mjs`, and the test documents are in `tests/fixtures/documents/`. OpenAPI descriptions are in `openapi/system.yaml` and `openapi/tester.yaml`. Implementation details are in [Cross-team testing interface](#cross-team-testing-interface).

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

The DOCX's Section 5.2 supplies the more precise severity and location fields; it notes these need pod confirmation. Keep `parseReport()` in `frontend/core.js` aligned if the pod adopts different fields. `/formats` is authoritative for discovery: this implementation supports HTML, PDF, DOCX, and plain text. The service rejects empty, malformed, non-UTF-8, and mismatched files, does not trust browser filenames, and enforces 10 MiB (10 × 1,048,576 bytes). The Phase 2 phrase “10 MB” does not define decimal versus binary units; this implementation follows the peer tester's 10 MiB interpretation pending pod confirmation.

Error responses use `{"code":"UNPROCESSABLE_FILE","message":"The file could not be evaluated."}`.

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
| Access / run notes | No authentication. Maximum times: system setup 70 s (the free hosting plan can take up to 60 s to wake); tester setup 70 s (including target setup); tester run 17 minutes (15 target calls, each with a 60 s limit, plus coverage retrieval). |

**System** (`testing/system.mjs`):
- `POST /test/setup` accepts `{"session_id":"…","setup":{}}` and returns 201 with the same ID. It returns 409 for a duplicate ID and 400 for an invalid body.
- `GET /test/report?session_id=…` returns code coverage (200), or 404 for an unknown session.
- The project API is stateless, so setup only registers the session. Line coverage isn't instrumented in the deployed service, so `covered` and `total` are `null` and `basis` explains why, as the spec allows.

**Tester** (`testing/tester.mjs`):
- `POST /tester/test/setup` with `{"target_url":"https://other-team.example/system"}` creates a session (UUID), calls the target's `/test/setup`, and returns 201 when the target is ready. It forwards the target's error status, message, and source.
- `POST /tester/test/run` with `{"session_id":"…"}` runs tests T-01 to T-15 in order against the target's `/health`, `/formats`, and `/analyze`. It returns one report with a `pass`, `fail`, `error` (with `source`), or `skip` outcome per test, plus code, component, and system coverage.
- `GET /tester/test/report?session_id=…` returns the stored report, or 409 before the suite ends.
- A session runs only once. Running it again returns 409.

The suite checks:
- health and formats
- missing alt text (HTML and DOCX)
- contrast at level AA, and its exclusion at level A
- contrast from colors set in an embedded `<style>` sheet (T-14, added in Phase 4)
- the no-issue report
- PDF analysis, and a figure without alt text in a tagged PDF (T-15, added in Phase 4)
- expected errors: unsupported type (415), empty file (422), corrupt DOCX (422), missing file (400), and invalid `wcag_level` (400)

DOCX and PDF tests are skipped when the target's `/formats` doesn't list that format.

Component and system coverage count the components and acceptance criteria listed in the pod specification. Until the pod lists are added to `testing/pod-spec.json`, both are reported as `null` with an explanation. To fill them in, map each pod item ID to the tests that exercise it, for example `"items": {"AC-01": ["T-03", "T-07"]}`.

Both services are described in `openapi/system.yaml` and `openapi/tester.yaml`. CI validates both files on every push. The smoke test also runs the tester against the service's own system.

## Interface behavior

- Browse for one file or drag and drop it; inspect its name and size, or remove it.
- Reject empty, oversized, and unsupported selections before upload. The limit uses binary megabytes (`1 MB = 1,048,576 bytes`); confirm this interpretation with the pod because Phase 2 does not define the unit convention.
- Choose WCAG 2.1 A or AA, with AA selected initially.
- Show a waiting indicator and elapsed seconds. Cancel the browser request without claiming that server-side processing has stopped.
- Display complete findings with criterion, severity, available location, description, and suggested fix. Filter by severity.
- Explicitly show no supported violations for an empty issues array and retain the compliance limitation.
- Download the current report as JSON. Downloads preserve the server report fields and add `frontend_context` identifying the document, level, and whether the report is a sample.
- Use semantic HTML, native controls, keyboard focus indicators, a skip link, live announcements, dialog focus handling, responsive layout, and reduced-motion support.

**Check and repair** sends the document to `POST /remediate` instead. The report then shows the automated repairs (each marked **Review** when the service chose a value or changed appearance), a button to download the repaired copy, and the findings that remain. The repaired file exists only in page memory until downloaded. A JSON download after a repair also includes the change list and the findings before repair.

There is no compliance score, account system, report history, or document preview. The backend owns parsing, WCAG detection, remediation generation, file integrity checking, and uploaded-file deletion. The frontend stores no uploads or reports in localStorage, cookies, or a database. Completed uploads are released from frontend state; current results exist only in page memory until replaced or the page closes. Downloading JSON is an explicit user action and creates a local copy.

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
| 1.3.1 Info and Relationships | A | PDF is not tagged (one document-level finding) | serious |
| | | Heading levels skip (H1 → H3) | moderate |
| | | First heading is not H1 | minor |
| | | 1,500+ characters of text and no headings | moderate |
| | | Large or bold standalone text that looks like an unmarked heading | moderate |
| | | Data table has no header row or column | moderate |
| 1.4.3 Contrast (Minimum) | AA | Below 4.5:1 for normal text or 3:1 for large text (18pt+, or 14pt+ bold), including link text | serious if far below the threshold, otherwise moderate |
| 2.4.2 Page Titled | A | Document title property is missing | moderate |
| 2.4.4 Link Purpose | A | Link text is empty / generic ("click here", "read more") / a raw URL | serious / moderate / minor |
| 2.4.6 Headings and Labels | AA | Heading is empty | serious |
| 3.1.1 Language of Page | A | Document language is missing or invalid | moderate |

With `wcagLevel: 'A'`, the report omits the AA criteria (1.4.3 and 2.4.6). Images with `alt: ""` or `decorative: true` are treated as decorative. The engine skips colors it cannot parse instead of guessing. If an element has `color` but no `background`, the engine assumes a white background. Findings are sorted by page and then line, with document-level findings first.

### Parsed document input (contract with the parser)

The `elements` array is in reading order. Only `type` is required; the engine uses any other fields that are present. It ignores unknown element types and fields, so the parser can send more data than the engine uses.

`metadata.not_extracted` lists things the parser could not observe for this format. The engine skips the matching checks so that "unknown" is never reported as "missing". The values are `alt_text`, `headings`, `tables`, `title`, and `language`. For PDFs the parser also sends `metadata.tagged`. A tagged PDF has its headings, figures (with `/Alt` or `/ActualText`), and tables read from its structure tree, so nothing is listed as not extracted. An untagged PDF (`tagged: false`) lists `["alt_text","headings","tables"]`: those semantics do not exist for assistive technology, and the engine reports the missing tags once instead. For plain text it sends all five values, because plain text cannot contain any of these.

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
| `color`, `background` | `#rgb`, `#rrggbb`, `rgb(r,g,b)`, `{r,g,b}`, or a basic CSS color name; allowed on any text-bearing element. For HTML the parser sends resolved hex values (see [Contrast from stylesheets](#contrast-from-stylesheets)) |
| `contrast_unknown` | `true` when colors are set but cannot be evaluated (CSS variables, background images); no `color` is sent, so contrast is skipped |
| `metadata.tagged` | PDF only: whether the PDF has a structure tree. `false` produces the "PDF is not tagged" finding |
| `font_size_pt`, `bold` | Used to decide whether text is large for contrast purposes |
| `table.layout` | `true` excludes layout-only tables from the header check |
| `location` | Optional `{page, line, selector}`; invalid values are dropped. The engine adds a `snippet` from the element text |

## Contrast from stylesheets

`accessibility-parser/parser/css.py` resolves the CSS that decides what color text is drawn in, and on what background. It handles:

- embedded `<style>` sheets and inline `style` attributes;
- selector specificity, source order, and `!important`;
- inheritance of `color`, `font-size`, and `font-weight`;
- browser defaults for heading size and bold text;
- `@media screen` and `@media all` blocks.

The background behind text is the nearest ancestor's `background-color` (or the color in a `background` shorthand). Semi-transparent backgrounds and text colors are composited over what is below them. Hidden text (`display: none`, `visibility: hidden`, `hidden`) has no contrast requirement.

These are skipped as unknown rather than guessed: colors from `var()`, backgrounds with images or gradients, conditional media queries, `:hover`/`:focus` states, and external stylesheets. The service never fetches URLs from uploaded documents, so it reports the number of external stylesheets in `metadata.external_stylesheets`.

## Tagged PDFs

`accessibility-parser/parser/pdf_tags.py` walks the PDF structure tree (`/StructTreeRoot`, ISO 32000-1 section 14.8) and applies the `/RoleMap`. Figures (and their `/Alt` or `/ActualText`) and tables (rows inside `THead`/`TBody`/`TFoot`, and `TH` versus `TD` cells) come directly from the tree, so a table that spans pages is counted once. Heading levels and text come from MuPDF's structured-text output, which maps page content to tags through the PDF's `/ParentTree`.

If a tagged PDF has no usable ParentTree, heading checks are skipped (`not_extracted: ["headings"]`). Figures and tables are still checked. Cycles in the tree are ignored, and very large trees are capped at 50,000 elements. The fixture `tests/fixtures/documents/tagged.pdf` is generated by `make_fixtures.py`. It is written by hand because PyMuPDF cannot create tags.

## Remediation

`POST /remediate` takes the same upload as `/analyze`. It writes a repaired copy in the upload's private temporary directory, then parses that copy and runs the engine on it again. That means `issues_after` is exactly what `/analyze` reports for the repaired file; the repair code never judges its own work. Both temporary files are deleted afterwards.

| Repair | WCAG | HTML | DOCX | PDF |
| --- | --- | --- | --- | --- |
| Set the document language (from `language`, default `en`) | 3.1.1 | yes | yes | yes |
| Set the title (from `title`, else the first H1, heading, or line) | 2.4.2 | yes | yes | yes, with `DisplayDocTitle` |
| Remove empty headings | 2.4.6 | yes | yes (to Normal text) | no |
| Close gaps in heading levels; sibling headings stay siblings | 1.3.1 | yes | yes | no |
| Mark the first row of a header-less data table as the header | 1.3.1 | yes (`<th scope="col">`) | yes (repeating header row) | no |
| Change low-contrast text to the nearest color of the same hue that passes | 1.4.3 | yes (inline `color`) | yes (run color, against white) | no |

Existing valid titles and languages are kept. These are never generated, because they need human judgment: alternative text, link wording, and tags for an untagged PDF. They stay in `issues_after` with their suggested fixes. Plain text is returned unchanged.

Each change has `wcag_criterion`, `description`, `location` (the shared location shape), and `needs_review`. `needs_review` is `false` only for values the user supplied and for removing empty headings.

The repaired file is returned as base64 in `remediated_file`, with a download name made from the upload name reduced to safe characters plus `-remediated`. Re-serializing HTML can change insignificant formatting, such as `<br>` becoming `<br/>`. Renaming a heading tag can change its default size; that change is marked for review.

## Known limitations

- **Error-code detail:** Error bodies follow the Phase 2 `{code,message}` shape. The implementation also uses specific codes for malformed requests and parser timeouts; the pod should keep the code list aligned as the shared OpenAPI contract is refined.
- **Coverage:** code coverage is reported as `null`, because line instrumentation isn't enabled in the deployed service. Component and system coverage are `null` until the pod's component and acceptance-criteria lists are added to `testing/pod-spec.json`.
- **PDF analysis:** tagged PDFs are checked for heading order, figure alt text, and table headers from their tags. Other tag roles (lists, reading order compared with visual order, artifacts) aren't evaluated, and an untagged PDF gets one "not tagged" finding rather than per-element findings. Scanned PDFs (images of text) aren't analyzed, and PDF text contrast assumes a white background.
- **Contrast:** HTML contrast covers embedded and inline CSS but not external stylesheets, `var()`, background images or gradients, conditional media queries, or interaction states (see [Contrast from stylesheets](#contrast-from-stylesheets)). DOCX contrast uses run colors against white; paragraph shading isn't read.
- **Remediation** repairs only mechanical problems; alt text, link wording, and PDF tagging still need a person. PDF repair is limited to title and language. DOCX heading repair needs the document to define the target `Heading N` style. The repair endpoint isn't part of the shared pod contract, so podmates' testers don't exercise it.
- **New tester cases T-14 and T-15** check stylesheet contrast and tagged-PDF alt text. These go beyond what a podmate's system may implement if the pod specification only requires inline styles and untagged PDFs.
- **Locations:** DOCX locations are body element positions, not page numbers. HTML `line` values are element order, not source lines.
- **Remediation guidance** is fixed text for each check. No AI-generated suggestions are included yet.
- **Availability:** the free hosting plan sleeps after about 15 minutes idle, and the first request after that can take up to 60 seconds. Test sessions are kept in memory, so a restart or redeploy clears them.
- **The tester assumes our interpretation of the shared API**, for example contrast checks at level AA, a 415 error for unsupported types, and a 422 error for empty files. A podmate's system may differ where the pod specification is unclear.

## Verification

```sh
npm test
```

`tests/core.test.mjs` covers URL restrictions, discovered formats, file-type and size boundaries, complete/partial report validation, multipart field preservation, HTTP errors, pending responses, timeout, and cancellation. `tests/engine.test.mjs` covers each engine check, contrast math against WCAG reference values, A/AA filtering, rejection of invalid parser output, and that every engine report passes the frontend's `parseReport()`. `tests/backend.test.mjs` starts the actual local service on an ephemeral loopback port and verifies health, format discovery, CORS, UI serving, successful HTML analysis, WCAG-level filtering, and malformed/unsupported upload responses. `tests/integration.test.mjs` runs end to end through the Python parser. It uploads real DOCX, PDF, and TXT files from `tests/fixtures/documents/` and checks that each report contains the expected findings and passes `parseReport()`. It also covers MIME fallback by file extension, corrupt, encrypted, mismatched, and non-UTF-8 files (422), temp-file deletion, a missing or hung parser (503), oversized and malformed uploads, CORS preflight, and path-traversal attempts.

`tests/remediation.test.mjs` covers `POST /remediate` end to end for HTML, DOCX, PDF, and TXT. It checks which findings are repaired and which remain, that re-analyzing the returned file gives exactly `issues_after`, level A filtering, title sanitizing, every error response, and temp-file deletion. The PDF and stylesheet features are covered in `tests/integration.test.mjs` (the tagged and untagged fixtures, and contrast from a `<style>` sheet) and in the parser tests.

`tests/test-interface.test.mjs` covers the cross-team testing endpoints. It checks system setup and report (201, 409, 400, 404); a full tester run against this system in which all 15 tests pass and the stored report stays unchanged; forwarding of target setup failures; unreachable targets (source `communication`); and per-test outcomes when a fake target times out, returns 500, sends an invalid report, or doesn't support DOCX or PDF.

Parser tests run separately: `cd accessibility-parser && .venv/bin/python -m pytest -q`. `tests/test_css.py` covers the CSS cascade, colors, and contrast fixes; `tests/test_parser.py` covers tagged PDFs, including a missing ParentTree, `/ActualText`, and a cyclic tree; `tests/test_remediate.py` covers each repair per format and the CLI. To regenerate the document fixtures, run `accessibility-parser/.venv/bin/python tests/fixtures/documents/make_fixtures.py`. GitHub Actions (`.github/workflows/test.yml`) runs both test suites on every push, then builds the Docker image and runs the smoke test against it.

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

The UI itself has not been certified for WCAG conformance; keyboard support and visual checks are implementation evidence, not a full assistive-technology audit.

## Files

- `frontend/index.html`: semantic markup and application structure
- `frontend/styles.css`: responsive visual design and interaction states
- `frontend/app.js`: UI state, upload workflow, connection dialog, report rendering, and downloads
- `frontend/core.js`: API client, validation, response parsing, and error handling
- `frontend/config.js`: backend URL and analysis timeout
- `frontend/samples.js`: fixed demonstration reports
- `engine/`: accessibility analysis / WCAG engine (`index.mjs` entry point, `checks.mjs` rules, `contrast.mjs` color math, `cli.mjs`)
- `server.mjs`: API (upload validation, content-type checks, error mapping), CORS handling, and static UI server
- `accessibility-parser/`: Prathum's Python document parser; `integration.mjs` is the Node bridge (temp file, timeout, cleanup). `parser/css.py` resolves stylesheets for contrast, `parser/pdf_tags.py` reads PDF structure trees, and `parser/remediate.py` repairs documents
- `testing/`: cross-team testing interface (`system.mjs`, `tester.mjs` and its suite, `pod-spec.json` for coverage)
- `openapi/`: OpenAPI 3.1 descriptions of the system and tester
- `Dockerfile`, `scripts/smoke-test.sh`, `.github/workflows/test.yml`: deployment, post-deploy check, and CI
- `tests/`: automated tests, synthetic fixtures, and test service
- `UI_HANDOFF.md`: requirements mapping and engineering handoff

## Phase 4 changes

**New functionality**
- **Remediation:** `POST /remediate` and the **Check and repair** button repair language, title, empty headings, heading gaps, table header rows, and text contrast. They return the repaired file with a list of changes and the findings before and after.
- **Tagged PDFs:** heading order, figure alt text, and table headers are now checked from the PDF's tags. Untagged PDFs get a "not tagged" finding (1.3.1, serious).
- **Contrast from stylesheets:** HTML contrast now follows embedded CSS, specificity, inheritance, and nested or semi-transparent backgrounds. Link text is now checked for contrast.

**Interface changes**
- `/analyze` responses keep the shared shape. They can include more findings than before: untagged-PDF and tagged-PDF structure findings, and stylesheet and link contrast findings.
- `/remediate` is new.
- The tester adds T-14 and T-15.
- `openapi/system.yaml` documents `/remediate`, and the tester spec lists T-01 to T-15.

**Tests:** 51 Node tests (37 before) and 52 parser tests (9 before). The smoke test also checks the tagged PDF, stylesheet contrast, and `/remediate`.

**Still incomplete:** AI-generated alt text suggestions, PowerPoint and Excel formats, repairs inside PDFs beyond metadata, and component/system coverage (`testing/pod-spec.json` still needs the pod's lists).

## AI contribution

Codex generated the frontend implementation, examples, tests, and handoff documentation from the four supplied phase documents. Generated output was checked with automated tests and browser interaction/visual checks. This records the assistance used; it does not imply that teammates or instructors have reviewed or approved the work.
