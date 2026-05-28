# PWA Icons

Place two PNG files here before deploying:

| File | Size | Used for |
|---|---|---|
| `icon-192.png` | 192 × 192 px | Android home screen, manifest |
| `icon-512.png` | 512 × 512 px | Splash screen, Play Store |

Both should be the salon logo on a solid `#1a5252` (teal) background, with enough padding so the logo isn't clipped by circular/rounded-square masks.

The `icon-512.png` is declared `purpose: maskable` in the manifest, so keep the logo within the safe zone (center 80% of the canvas).

iOS uses `icon-192.png` as the Apple touch icon (referenced in index.html).
