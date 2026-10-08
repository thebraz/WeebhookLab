# Changelog

## 0.1.1 — 2026-10-08

### Fixed

- Corrected the MIT copyright holder and package author to braz.

## 0.1.0 — 2026-10-08

### Added

- Local HTTP webhook capture with original raw bytes, SQLite persistence, real-time inspection, filters, pins, and cursor pagination.
- Editable HTTP/HTTPS replay with actual responses, cancellation, bounded timeouts/buffering, and persistent execution history.
- Structural event/request/response comparison, JSON paths, Set/Delete/Rename pipelines, and evidence-based provider hints.
- Saved requests, exact-path mock response profiles, isolated workspaces, and validated/redacted workspace import/export.
- Installable CLI with host, port, workspace, browser-opening, help, and version options; packaged inspector assets and per-user storage.
- Deterministic local demo, clean installation smoke checks, release regression/performance tests, and a Windows CI definition.

### Fixed

- Adaptive event-list scrolling, compact collapsible filters, keyboard focus, and preservation of older loaded events during live updates.
- Endpoint configuration opens in a dedicated panel with visible save actions, contextual validation, and unsaved-change protection.

- SSE summary delivery across workspace boundaries and reconnection without increasing retry delays.
- Hardcoded capture URLs when running on another port, first-load error recovery, and filtered empty states.
- Event list clipping on small screens and inspector shortcuts firing behind an open command dialog.
- Potential payload exposure in malformed replay JSON errors and export leakage from encoded form fields or nested sensitive transformation paths.
- Unbounded JSON preview depth and expensive syntax highlighting for large editor bodies.
- Known static-file dependency vulnerabilities by updating the compatible Fastify plugin.

### Changed

- The application interface, CLI, validation feedback, and historical system-message display use English.
- Adopted the MIT license and public npm/GitHub package metadata with owner authorization.

- Runtime distribution allowlists compiled server/shared modules and frontend assets; React is a development dependency.
- Public documentation describes actual local workflows, limits, storage, and unpublished status.

Existing SQLite workspace migrations are covered for new, historical, partial, and interrupted schema states. Existing local databases are preserved and excluded from distribution.
