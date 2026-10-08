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

## Verification

```sh
npm test
```

Seven automated tests cover URL restrictions, discovered formats, file-type and size boundaries, complete/partial report validation, multipart field preservation, HTTP errors, pending responses, timeout, and cancellation. Tests do not require a backend.

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
- `server.mjs`: local static preview server
- `tests/`: automated tests, synthetic fixtures, and test service
- `UI_HANDOFF.md`: requirements mapping and engineering handoff

## AI contribution

Codex generated the frontend implementation, examples, tests, and handoff documentation from the four supplied phase documents. Generated output was checked with automated tests and browser interaction/visual checks. This records the assistance used; it does not imply that teammates or instructors have reviewed or approved the work.
