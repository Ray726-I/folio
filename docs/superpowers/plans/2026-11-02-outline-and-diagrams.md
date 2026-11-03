# Outline and Diagram Polish Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent diagram implementation and focused reviews.

**Goal:** Implement the six UI improvements approved by the user: readable wider outline, stronger hierarchy, active marker, collapsible heading groups, accessible diagram expansion (heading search was removed at the user’s request before commit).

**Architecture:** Keep headings and source offsets in the existing outline model. Add a dedicated outline controller for visibility, collapse state and keyboard navigation. Use a separate diagram viewer that clones an already rendered diagram into a modal without modifying document content. Preserve saved sidebar widths and existing document-follow behavior.

**Tech Stack:** Plain JavaScript, HTML/CSS, Tauri, existing Playwright fixtures.

## Outline

- [x] Add regression coverage for collapse, wrapping and unchanged document text.
- [x] Increase the unsaved default dock width to 280 px; provide a persisted two-line outline-title option with stable row geometry.
- [x] Add stronger parent hierarchy, consistent indentation, and an accent marker for the current section.
- [x] Build parent/child relationships, separate disclosure buttons, keyboard support, and per-document collapse state retained across outline refreshes.
- [x] Remove heading search, filtering logic, and related styles as requested before commit; retain the section count and collapsible outline.
- [x] Keep active-section follow compatible with hidden descendants and manual exploration.

## Diagrams

- [x] Add a hover/focus-visible Expand action to rendered diagrams, including editor-rendered Mermaid hosts.
- [x] Add an accessible modal viewer with fit, zoom, close/Escape, focus restoration, and no document mutation.
- [x] Verify sanitized rendering remains the only source of SVG; exclude failed and pending diagrams.

## Review and verification

- [x] Review requirements and code quality; resolve actionable findings.
- [x] Run focused outline, sidebar, diagram and editor interaction regressions.
- [x] Inspect dark/light and narrow-window previews.

Verified outline-controls, outline-follow, editor-extension-outline, navigation-dock, header-screen-proportions, editor-a11y-focus, ui-smoke and coarse-touch-targets. Diagram implementation verified diagram-viewer, editor-mermaid-source, mermaid-bridge and editor-history-regressions. Reviewed dark/light/narrow previews; spec and quality review findings were resolved. Syntax checks and git diff --check pass.
