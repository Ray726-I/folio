# Native text rendering investigation — 2026-11-01

The persistent gray appearance had a reproducible palette initialization bug.
The previous font and contrast adjustments did not address this startup timing.

## Evidence

- The running Linux app used native Wayland, not XWayland. The monitor scale and
  desktop text scale were both 1.0. Folio's stored app zoom was 1.2 and text size 17px.
- Native WebKitGTK 2.54.2, loading the real UI in an ephemeral GTK WebView, sometimes
  returned `rgba(0, 0, 0, 0)` from the off-screen theme probe before first layout.
  In some runs, root custom properties were also unavailable until the first frame.
- The old normalizer dropped alpha, turning transparent into black. Contrast
  calculations then produced body `#767676` and strong text `#959595`, which stayed
  frozen even after the actual dark theme resolved to background `#242424` and
  foreground `#eeeeec`.
- Direct root reads alone did not fix every native startup: missing first-frame
  tokens could still create `#NaNNaNNaN` custom properties. Invalid inputs must be
  rejected and palette generation deferred.

## Change

Read opaque theme tokens directly, preserve transparent values, and validate all
palette inputs. Before first layout, retain ordinary CSS foreground fallbacks and
retry on animation frames with a bounded retry count. Refresh diagram colors when
valid colors become available. Avoid unnecessary duplicate refreshes.

Body text uses the full theme foreground, adjusted only when necessary to reach
7:1 contrast. Reading accent colors keep their original saturation unless contrast
requires adjustment. No font weight, text shadow, glow or desktop settings change.

## Verification

`npm run test:native-palette` loads the real frontend in isolated native WebKit at
100% and 120% zoom. Both resolve the tested dark palette to body `#eeeeec` (13.36:1)
and the light palette to body `#2e3436` (12.12:1), with no text shadow or page errors.
`tests/palette-startup.cjs` simulates transparent probe readings and missing root
variables to guard both failure paths. The UI suite also checks theme isolation,
system appearance updates, diagram rendering and normal reading/editing behavior.

The native test windows use Xvfb/X11. GPU compositing under the user's live Wayland
session was not independently reproduced; isolated compositing tests could not
establish a separate raster blur defect. The confirmed fix addresses the erroneous
washed-out palette. Restart the embedded desktop app to load it before reassessing
any remaining softness.

## Header selection strip — 2026-11-02

Native WebKitGTK rejects the unprefixed `user-select: none` declaration. The
document title and full-width path row therefore remained selectable, and GTK's
inactive selection painted black rectangles behind them. A native X surface
capture reproduced the reported strip; the WebKit snapshot API hid that paint.

Add `-webkit-user-select: none` to the existing header rule. The native palette
check now verifies that header text cannot be selected while document text can.
The check passes at 100% and 120% zoom, and the native surface capture is clean.
