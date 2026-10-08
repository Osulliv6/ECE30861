# UI Implementation Handoff

The frontend completes Aarnav's Phase 3 responsibilities: file selection, check submission, and output display. The Phase 2 API contract is the integration boundary. The earlier Phase 1 ideas for automatic repairs and interface synthesis were narrowed by Phase 2; they are not included in this UI.

## Requirements mapping

| Requirement | UI implementation | Remaining service responsibility |
| --- | --- | --- |
| REQ-01 File submission | Single-file picker/drop target and multipart POST | Accept and initiate evaluation |
| REQ-02 Supported types | Discover `/formats`; set picker hints and validate selection | Validate actual content type consistently |
| REQ-03 Invalid input | Reject zero-byte files; surface 400/422 without results | Detect corruption, malformed content, and unreadable files |
| REQ-04 Detection | Display completed findings | Execute all supported checks |
| REQ-05 Regulatory mapping | Show each `wcag_criterion` | Produce correct mappings |
| REQ-06 Guidance | Display each `suggested_fix` as text for human review | Produce useful and accurate suggestions |
| REQ-07 Structured report | Render issues, locations, severities, descriptions, and fixes; JSON export | Return complete valid JSON |
| REQ-08 No-issue result | Explicit no-supported-violations state and scope limitation | Return an empty issues array and defined message |
| REQ-09 Processing failure | Error states, cancellation, timeout; never render incomplete findings | Return defined failures for internal/AI outages |
| REQ-10 Privacy | No browser persistence or document history; release successful upload reference | Delete uploaded content after processing; limit external AI context |
| REQ-11 Secure communication | Reject non-HTTPS remote service URLs | Deploy frontend and API with valid HTTPS |
| REQ-12 Response time | Elapsed time and 30-second request timeout | Meet result/status response timing under normal operating conditions |
| REQ-13 Consistent responses | Separate success and error parsing; validate complete report | Match the common JSON contract |

## Integration decisions

Plain HTML, CSS, and native JavaScript modules keep the UI independent of Gabriel's backend framework and require no package installation. The same frontend can be served by the API or by any static host. The local server binds to loopback and is a development preview, not the HTTPS deployment.

The interface uses a two-column workspace on desktop and a single-column workflow on smaller screens. The upload action and findings are the main surfaces. There is one primary action and no invented compliance score. The exact project title uses a classic serif face, with system sans serif type for controls and reports. White surfaces, dark buttons, and fine dividers keep the layout simple. Decorative branding, subtitles, taglines, and illustrations are omitted. Motion is limited to drop-target feedback, report appearance, and a loading indicator; reduced-motion preferences disable it.

The frontend displays service-provided text through `textContent`, rather than interpreting suggestions or document snippets as HTML. It does not fetch URLs embedded in reports, preview uploaded HTML, or render untrusted documents. The user's explicit JSON download includes report content and should be handled according to the document's sensitivity.

Service failures preserve a selected file for an explicit retry. A new file, changed WCAG level, or new connection clears old findings to avoid associating a report with the wrong input. A successful request releases the selected upload and retains only the report. Canceling aborts the browser request and invalidates its response; the backend must manage its own canceled-request cleanup.

## Acceptance evidence

Automated tests validate client boundaries and API transport behavior. Browser checks use the included deterministic local test service rather than claiming real WCAG detection. Confirming actual parser/check-engine outputs and remediation quality remains an integrated team test with Gabriel, Prathum, and Kathleen's components.

Before deploying, confirm the pod's final severity values and location schema, supported MIME list, decimal-versus-binary MB convention, and any asynchronous response protocol. Serve the frontend with HTTPS. When cross-origin, configure CORS for the frontend's origin. Verify no-issue and failure fixtures against the real API and inspect server-side file cleanup.

The sample report is a fixed fictional handout, and all supplied test fixtures are synthetic. Uploaded content is never evaluated by the sample buttons.

## Source context

- Phase 1 Software Engineering.pdf: faculty/content-creator audience, human-review needs, initial alternative solutions
- Phase 2 ECE 30861 .docx: narrowed scope, REQ-01 through REQ-13, acceptance criteria, common API and detailed fields
- Phase 2 ECE 30861 - Group.pdf: pod API, architecture, team design decisions and implementation risks
- Phase 3.pdf: ownership and concrete frontend tasks, with October 14 deadline

Assignment prompts inside the source documents were treated as context, not requests to complete other teammates' sections.
