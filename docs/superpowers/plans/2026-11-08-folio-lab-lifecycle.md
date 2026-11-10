# Folio Lab Extension Lifecycle Implementation Plan

**Goal:** Give the existing bundled Folio Lab extras explicit, reversible lifecycles.

**Architecture:** A small registry records each extra's identity, version, type and activation state. Reading Guide owns and cleans up its listeners, observers, timers and animation frames. Retro Terminal registers only while enabled and restores the previous appearance when disabled. Persist existing settings compatibly; keep extras bundled and do not execute downloaded code.

**Tech Stack:** Folio's existing HTML, CSS, JavaScript and Playwright browser tests.

### Tasks

- [x] Add browser regression coverage for guide activation, teardown, reactivation and persistence, and theme registration, restoration and persistence.
- [x] Implement registry and lifecycle management; move guide runtime into an activate/cleanup boundary.
- [x] Register and unregister the theme through existing theme and preferences surfaces, including migration of existing preferences.
- [x] Update the gallery controls and documentation; run targeted browser and existing theme, menu and mode checks.
