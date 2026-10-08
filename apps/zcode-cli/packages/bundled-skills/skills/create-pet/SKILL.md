---
name: create-pet
description: "Use when the user wants to create, customize, or hatch a desktop pet for this app (Mikiko): turning a character concept, reference image, brand mascot, or an existing sprite sheet into an installed pet. Covers collecting a user-provided image-generation API, building spritesheet prompts, verifying the exact 8-column grid, writing pet.json, and installing into the pets directory."
when_to_use: "Custom pet creation, repair, or repackaging. Browsing or installing market pets is an app UI feature, not this skill."
---

# Creating a custom desktop pet

Produce an installed custom pet: `~/.mikiko/v2/pets/<pet-id>/pet.json` + `spritesheet.webp`. After install the pet appears in the app's pet switcher (right-click the pet → switch pet, or the pet market's installed list).

**This skill never generates images by itself.** The user provides an image-generation API (their own endpoint and key); you build the prompts, call their API, and verify the output. Never fabricate a "generated" sheet from placeholders, and never install an image that fails verification.

Read `references/pet-format.md` before writing any generation prompt — it is the exact atlas contract the app enforces at load time.

## Workflow

### 1. Collect requirements

Ask the user for (in one round, not one-by-one):

- **Pet concept**: name, short description, art style, any reference images (file paths). References make character consistency far easier — encourage them.
- **Image-generation API**: base URL, API key, model name, and the request shape. If the user hands you an OpenAI-compatible endpoint, assume `POST {base}/v1/images/generations` with `{ model, prompt, size, n }` and a response of `{ data: [{ url }] }` or `{ data: [{ b64_json }] }` unless told otherwise. If it is anything else, ask for one working `curl` example or the API doc page, and adapt.
- Keep the API key out of files you write to disk: pass it inline or via an environment variable in the shell command only. Do not put it into pet.json, prompts, or any committed file.

If the user already has a finished sprite sheet image, skip to step 4 (verify → package → install).

### 2. Choose the atlas target

Default to the **v1 atlas** (`1536×1872`, 8 columns × 9 rows of `192×208` cells). Only attempt v2 (`1536×2288`, adds two look-around rows) if the user explicitly wants it and the API quality is already proven on v1.

### 3. Generate the sheet

First choice: **single-shot full-sheet prompt** — one image containing the whole 8×9 grid. Use the row-by-row action table from `references/pet-format.md` inside the prompt, plus these invariants:

- One character, one palette, same scale and ground line in every cell.
- Strict grid: exactly 8 columns × 9 rows, each cell 192×208, no grid lines / numbers / labels / borders drawn in the image.
- Transparent background (or a solid uniform background the user accepts — the pet renders as a rectangle otherwise; warn them).
- Trailing cells in a row may be blank (padding) — the default animations never read them; leading/middle cells must not be blank.
- Ask for exact output size `1536×1872` (v1) or `1536×2288` (v2) in the API's size parameter, in whatever syntax that API uses.

If the API only supports fixed sizes that do not match, or rows bleed into each other, fall back to **per-row strips** (`1536×208`, 8 cells of the requested row's action) and stitch rows vertically with the platform's image tooling (`magick`/`convert` if installed, `sips` on macOS can crop/resize but not stitch — prefer magick, and if neither exists, report the limitation instead of installing tooling without asking). Resize only with the aspect preserved.

### 4. Verify (mandatory, before every install)

Run the bundled checker on the final file:

```bash
node "<this skill's directory>/scripts/verify-sheet.mjs" path/to/spritesheet.webp
```

It parses PNG/JPEG/WebP headers without dependencies and exits non-zero unless the dimensions are exactly `1536×1872` or `1536×2288`. It also prints the row/column geometry. An image that fails verification will be rejected or misrendered by the app — iterate (regenerate affected rows, resize with aspect preserved) until it passes. Convert PNG/JPEG output to WebP (`magick input.png spritesheet.webp`, or `sips -s format webp input.png --out spritesheet.webp` on macOS) — the file must be named `spritesheet.webp`.

Visual review: if the user is present, show or describe the sheet layout (or emit the image) and let them approve the character/rows before installing. At minimum re-check the row order against the table — a swapped `failed`/`waiting` row is the most common mistake.

### 5. Write pet.json

Minimal, valid manifest (unknown keys are tolerated by the app, but keep it minimal):

```json
{
  "id": "<kebab-case-unique-slug>",
  "displayName": "<user-facing name>",
  "description": "<one line>",
  "spritesheetPath": "spritesheet.webp",
  "spriteVersionNumber": 2
}
```

Include `spriteVersionNumber` only for a v2 sheet. The `id` doubles as the install directory name and must not collide with an existing pet in `~/.mikiko/v2/pets/`.

### 6. Install and confirm

```bash
mkdir -p ~/.mikiko/v2/pets/<pet-id>
cp spritesheet.webp ~/.mikiko/v2/pets/<pet-id>/spritesheet.webp
cp pet.json ~/.mikiko/v2/pets/<pet-id>/pet.json
```

Overwriting both files in an existing directory is the update path. Then ask the user to confirm in the app (pet switcher or market → installed list rescans the directory; no restart needed). If the pet loads but animates oddly, regenerate only the affected row(s) and re-run steps 4–6.

## Failure honesty

If the user's API cannot produce a usable grid after a few iterations, say so concretely (what sizes/styles it returned, why they fail verification) instead of installing a broken sheet. Suggest: a different model on their endpoint, per-row generation, or picking an existing pet from the market.
