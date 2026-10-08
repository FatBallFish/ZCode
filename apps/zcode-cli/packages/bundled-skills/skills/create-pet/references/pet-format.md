# Pet atlas format (Mikiko desktop pet)

Contract enforced by the app at load time (`normalizePetManifest`, specs/desktop/desktop-pet.md). The format follows Codex pet packs, so any Codex-compatible sheet also works.

## Atlas geometry

| Version | Sheet size        | Columns | Rows | Cell size | Frames | Look rows |
| ------- | ----------------- | ------- | ---- | --------- | ------ | --------- |
| v1      | 1536 × 1872 px    | 8       | 9    | 192 × 208 | 72     | no        |
| v2      | 1536 × 2288 px    | 8       | 11   | 192 × 208 | 88     | rows 9–10 |

- Grid must cover the sheet **exactly**: `cellWidth × columns == sheetWidth`, `cellHeight × rows == sheetHeight`. Anything else is rejected.
- Sprite index = `row × 8 + column` (0-based, row-major).
- File name: `spritesheet.webp` (WebP container; PNG works only during authoring — convert before install).
- Transparent background is strongly preferred; a solid background renders as an opaque rectangle.

## Row → action table (v1 = rows 0–8)

| Row | Animation names                | Cells actually used | Content guidance                                                       |
| --- | ------------------------------ | ------------------- | ---------------------------------------------------------------------- |
| 0   | idle                           | first 6             | Breathing idle loop, facing viewer; cells 7–8 may be blank padding     |
| 1   | running-right / move_right     | 8                   | Run cycle moving right (side view)                                     |
| 2   | running-left / move_left       | 8                   | Same run cycle mirrored, moving left                                   |
| 3   | waving / wave                  | first 4             | One-shot hand wave, 4 key poses; cells 5–8 blank padding               |
| 4   | jumping / bounce               | first 5             | One-shot jump, 5 key poses; cells 6–8 blank padding                    |
| 5   | failed / sad                   | 8                   | Dejected loop (head down / drooping)                                   |
| 6   | waiting                        | first 6             | Waiting loop (typing / tapping / looking at watch); cells 7–8 blank    |
| 7   | running                        | first 6             | In-place light jog; cells 7–8 blank                                    |
| 8   | review                         | first 6             | Inspecting loop (magnifying glass / leaning in); cells 7–8 blank       |
| 9   | look (v2 only)                 | 8                   | Clockwise head turn, part 1 (16 frames split across rows 9 and 10)     |
| 10  | look (v2 only)                 | 8                   | Clockwise head turn, part 2                                            |

Blank padding rules: only **trailing** cells of a row may be blank; blank cells are never played by the default animation table, so do not put content there that matters. Every non-blank cell must contain the character at the same scale and ground line.

## pet.json

```json
{
  "id": "my-pet--custom",
  "displayName": "My Pet",
  "description": "One-line description shown in the switcher.",
  "spritesheetPath": "spritesheet.webp",
  "spriteVersionNumber": 2
}
```

- `id`: optional but recommended; kebab-case, unique across `~/.mikiko/v2/pets/`; doubles as directory name.
- `spritesheetPath` must stay inside the pet directory (no absolute paths, no `..`, no backslashes).
- `spriteVersionNumber`: include only for v2 sheets.
- Unknown keys are tolerated (ignored); known keys with wrong types are rejected.
- Optional `animations` overrides exist (`{ frames: [indexes], fps (≤60, default 8), loop (default true), fallback (default "idle") }`) but custom pets rarely need them — the default table above already maps every row.

## Validation the app performs on load

1. Exact grid coverage of the sheet (see geometry above).
2. Total frames ≤ 256; every referenced sprite index in bounds.
3. An `idle` animation must exist (it always does unless overridden away).
4. `spritesheetPath` confined to the pet directory.
5. Market installs additionally verify byte size + SHA-256 + WebP header against the market manifest — not applicable to hand-made pets.

## Install layout

```
~/.mikiko/v2/pets/<pet-id>/
  pet.json
  spritesheet.webp
```

The app scans this directory for the switcher and the market's installed list. No registration file, no restart needed.
