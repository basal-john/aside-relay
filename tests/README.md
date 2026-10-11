# Testing current features with SMURF

This suite follows Google's [SMURF](https://testing.googleblog.com/2024/10/smurf-beyond-test-pyramid.html):
**Speed, Maintainability, Utilization, Reliability, Fidelity**. SMURF guides where
each check belongs; a higher test count alone does not demonstrate coverage.

## Run from a fresh checkout

Use the Node version specified in the root README. Python dependencies must be
installed before running backend tests.

```bash
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npx playwright install chromium webkit
npm test
```

On Linux, use `npx playwright install --with-deps chromium webkit` to install the
browser system libraries too. CI runs the same aggregate command on Ubuntu
with Node 24 and Python 3.13. No Aside login, API key, access token, or running
daemon is required. `ASIDE_TEST_PYTHON` can select another Python executable.

| Command | Scope | Boundary |
| --- | --- | --- |
| `npm run test:unit` | Parsers, citations, errors, theme, visual document, service worker | Imports production TypeScript; DOM and worker platform APIs supplied locally |
| `npm run test:backend` | HTTP routes, native contracts, queue, runner, files, push, realtime | Actual Python application; native daemon, external push transport, and CLI execution stubbed |
| `npm run test:mutations` | Test sensitivity | Seeds unsafe URL, invalid counter, and private diagnostic defects in a temporary source copy; each must fail an assertion |
| `npm run build` | TypeScript and production compiler pipeline | React Compiler, StyleX, lazy chunks, production assets |
| `npm run test:smoke` | Product identity, production boot and reconnect recovery | Built JavaScript in JSDOM; no browser layout engine |
| `npm run test:e2e` | User journeys and layout | Built application in Chromium and iPhone-sized WebKit; stateful synthetic HTTP/WebSocket backend |
| `npm run test:repeat` | Browser repeatability | Runs every browser scenario three times, with retries disabled |

`test:smoke`, `test:e2e`, and `test:repeat` require a current production build.
`npm test` builds it automatically. A failed layer stops the aggregate command.
Browser failures save screenshots, traces, and an HTML report under
`output/playwright/`; CI uploads that folder on failure. Inspect a trace with
`npx playwright show-trace <trace.zip>`.

## How the five criteria affect the suite

| Criterion | Implementation | Observable result |
| --- | --- | --- |
| Speed | Pure transforms and bounded backend contracts run before browser journeys | Fast errors fail before compiling or starting browsers |
| Maintainability | Production modules are imported directly; one stateful API fixture owns each browser test's data | Changes in request/response contracts require explicit fixture updates |
| Utilization | One browser worker, isolated temporary files, task-owned localhost server | Tests do not compete with or modify the signed-in Aside account |
| Reliability | Condition-based browser assertions, explicit race gates, zero retries, repeated execution command | A first-run failure remains visible; a late response can be released at a chosen point |
| Fidelity | Production bundle, two browser engines, real ASGI routes and actual service-worker source | Compiler, DOM, routing, protocol, and bridge behavior are exercised together |

Browser contexts are recreated per test. Unexpected API requests fail the
fixture instead of receiving a generic successful response. Backend tests set
an isolated user directory, token, and inaccessible native executable/daemon
before importing application configuration; every native call must be
explicitly stubbed. ASGI tests do not run application startup hooks, which would
otherwise launch queue workers and warm the browser MCP connection.

## Feature coverage and the checks that own it

| Current behavior | Automated checks |
| --- | --- |
| Appearance palette reset, custom primary contrast, UI/content/code font persistence, live HTML preview and system changes | `unit/theme-visual.test.mjs`, `e2e/appearance.spec.ts`, `backend/test_fonts.py` |
| Send, immediate draft clear and blur, send/stop state, streamed response, failed delivery restore | `e2e/core-chat.spec.ts`, `boot.test.mjs`, `backend/test_api.py`, `backend/test_runner.py` |
| Duplicate run acceptance, lost acknowledgement, stale run correlation, reconnect snapshot, socket cleanup | `boot.test.mjs`, `backend/test_api.py`, `backend/test_realtime.py` |
| Queue/steer/edit/cancel, ordering, pause/resume, native consumed races, restart with attachments | `backend/test_followups.py`, `backend/test_native_queue.py`, `e2e/queue.spec.ts` |
| Models, provider, effort, fast mode, permission mode, incognito/project start and failure cleanup | `unit/responses.test.mjs`, `backend/test_runner.py`, `backend/test_native_sessions.py`, `e2e/core-chat.spec.ts` |
| Native chat visibility, Show all, history search/filter, pagination race, pins/read/archive/title | `backend/test_native_sessions.py`, `e2e/sidebar.spec.ts` |
| Pending read/archive changes, failed mutation rollback, archived-only row restoration | `e2e/sidebar.spec.ts` holds mutations and subsequent native refreshes so reloading cannot conceal a broken local rollback |
| Success toast auto-dismiss without changing dark-theme metadata or header geometry | `e2e/sidebar.spec.ts` |
| Unread completed dot, running indicator precedence, stable distinct subagent colors and tool paths | `e2e/activity-status.spec.ts` |
| Message long press/release, editing, quoting, turn navigation, native branch/side chat | `e2e/message-actions.spec.ts`, `backend/test_native_sessions.py` |
| Approval, child approval policy, confirmation, question/cancel, tasks and subagents | `backend/test_native_sessions.py`, `e2e/workspace-browser-files.spec.ts`, `e2e/activity-status.spec.ts` |
| Native projects, routines, memory, context, skills, MCP, tools, providers, devices and preferences | `backend/test_native_workspace.py`, `e2e/workspace-navigation.spec.ts` cover contracts, section navigation, project edits, redaction and preference recovery |
| Browser control, invalid coordinates/actions/keys/URLs, history/bookmarks/groups, keep-tab cleanup, finite MJPEG stream | `backend/test_native_browser.py`, `unit/browser-errors.test.mjs`, `e2e/browser-controls.spec.ts` |
| PiP movement/persistence/minimize/restore/expand/close | `e2e/workspace-browser-files.spec.ts` waits for settled geometry before comparing restored position |
| Upload signatures/limits/dedup, active content isolation, symlink/traversal rejection, artifact lifecycle | `backend/test_uploads.py`, `backend/test_files_security.py`, `e2e/workspace-browser-files.spec.ts` |
| Citation transport tags, streaming fragments, nested sources, Markdown/code preservation, unsafe links | `unit/citations.test.mjs` |
| Visual HTML policy/theme/messages, long-word constraints, source formatting, bounded long-history DOM | `unit/theme-visual.test.mjs`, `e2e/rendering.spec.ts` |
| Light/dark persistence, status-bar metadata, text size and sanitized errors | `unit/theme-visual.test.mjs`, `unit/browser-errors.test.mjs`, `e2e/workspace-browser-files.spec.ts` |
| Actual answer in push body, Unicode payload budget, focus leases, stale endpoint pruning, unsafe subscriptions | `backend/test_web_push.py` |
| Notification click acknowledgement, existing-window reuse, safe navigation fallback | `unit/service-worker.test.mjs` runs the actual `web/sw.js` |
| Notification destination loading inside the conversation, composer focus/viewport resize retaining the bottom | `e2e/navigation-viewport.spec.ts` |
| Missing/wrong credentials on every protected HTTP route, cookie/Bearer authentication, bootstrap spoof rejection | `backend/test_api.py`, `backend/test_realtime.py` |

Tests combine related assertions into scenarios. Backend subtests cover multiple
payloads without turning every input into a separate inflated test count.
Seeded mutation checks establish sensitivity for those three defect classes;
they are not an exhaustive mutation score.

## What still requires a live Mac or physical iPhone

Mocked native contracts verify procedure names, payloads, validation, redaction,
and rollback behavior. They do **not** prove that a future installed Aside
version implements those procedures. After upgrading Aside, use the root
README's live acceptance checks against a dedicated test conversation.

WebKit device emulation supplies a mobile viewport and touch input, not the iOS
software keyboard, Home Screen installation, native menu chrome, status-bar
pixels, or APNs delivery. Verify these on the physical iPhone:

1. Install the HTTPS app on the Home Screen. Toggle dark mode and open/dismiss
   a toast; the status-bar region must keep the selected theme.
2. Type a multiline message with the keyboard open. A single send tap must
   submit once, clear the field immediately, and dismiss the keyboard. The
   conversation must retain its bottom position as the viewport changes.
3. Long-press a message, release, and choose a menu action. The menu must stay
   open until a choice or outside dismissal.
4. With a dedicated browser tab, drag/minimize/restore PiP, reopen the app,
   inspect its saved position, open the sheet/detail, and pinch/pan/dismiss.
5. Grant notifications, move the app out of focus, finish a response, and tap
   its notification. The actual response text and destination conversation
   must match. Repeat with the app already open and with no reusable window.

OS permissions, speech hardware, OAuth/native subscription management, native
browser profile reconnection, and actual provider responses require the live
environment. Report these as manual checks; automated fixture success is not
evidence that they passed.
