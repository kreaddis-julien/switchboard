#!/usr/bin/env python3
"""
Recolore public/style.css avec les palettes Catppuccin (Mocha en dark, Latte en
light) — surfaces, texte ET accents. Idempotent (garde un marqueur). Pensé pour
être rejoué tel quel après un rebase upstream qui réintroduirait des couleurs.

Deux passes :
1. Zone des variables `--c-*` : remappe chaque variable vers la tonalité
   Catppuccin équivalente (par rôle de luminosité), dans les 3 blocs (dark + les
   deux blocs light), et injecte les variables d'accent sémantiques.
2. Littéraux d'accent codés en dur (periwinkle / vert / orange / rouge / cyan /
   mauve) -> `var(--accent|ok|warn|amber|err|info|mauve[-rgb])`, en préservant
   l'alpha des rgba(). Le bloc `.markdown-preview` (thème Dracula) est protégé
   via une denylist de hex.
"""
import re
import sys
import pathlib

CSS = pathlib.Path(__file__).resolve().parent.parent / "public" / "style.css"
MARKER = "Catppuccin Mocha surfaces/text"

# --- 1. Bloc de variables : ancien (exact) -> nouveau (Catppuccin) ------------

OLD_VARS = """:root {
  color-scheme: light dark;
  --c-0e0e14: #0e0e14;
  --c-111118: #111118;
  --c-18181f: #18181f;
  --c-1a1a2e: #1a1a2e;
  --c-1e1e2a: #1e1e2a;
  --c-1e1e2e: #1e1e2e;
  --c-ffffff: #ffffff;
  --c-fff: #fff;
  --c-f0f0ff: #f0f0ff;
  --c-e0e0f0: #e0e0f0;
  --c-e0e0e0: #e0e0e0;
  --c-d8d8f0: #d8d8f0;
  --c-d0d0e8: #d0d0e8;
  --c-d0d0e0: #d0d0e0;
  --c-c0c0d8: #c0c0d8;
  --c-c0c0d0: #c0c0d0;
  --c-b8b8cc: #b8b8cc;
  --c-b0b0c4: #b0b0c4;
  --c-9090a8: #9090a8;
  --c-8a8aa0: #8a8aa0;
  --c-808098: #808098;
  --c-7a7a90: #7a7a90;
  --c-7a7a96: #7a7a96;
  --c-777790: #777790;
  --c-707088: #707088;
  --c-6a6a80: #6a6a80;
  --c-909098: #909098;
  --c-808090: #808090;
  --c-888: #888;
  --c-999: #999;
  --c-666: #666;
  --c-555: #555;
  --on: 255 255 255;
}
:root[data-theme="dark"] { color-scheme: dark; }
:root[data-theme="light"] { color-scheme: light; }

:root[data-theme="light"] {
    --c-0e0e14: #e4e4ec;
    --c-111118: #eeeef3;
    --c-18181f: #f6f6fa;
    --c-1a1a2e: #fbfbfe;
    --c-1e1e2a: #ffffff;
    --c-1e1e2e: #ffffff;
    --c-ffffff: #1c1c24;
    --c-fff: #1c1c24;
    --c-f0f0ff: #1c1c24;
    --c-e0e0f0: #1c1c24;
    --c-e0e0e0: #1c1c24;
    --c-d8d8f0: #222230;
    --c-d0d0e8: #252533;
    --c-d0d0e0: #252533;
    --c-c0c0d8: #3a3a46;
    --c-c0c0d0: #3a3a46;
    --c-b8b8cc: #3a3a46;
    --c-b0b0c4: #42424e;
    --c-9090a8: #5e5e6c;
    --c-8a8aa0: #5e5e6c;
    --c-808098: #5e5e6c;
    --c-7a7a90: #66667a;
    --c-7a7a96: #66667a;
    --c-777790: #66667a;
    --c-707088: #66667a;
    --c-6a6a80: #74748a;
    --c-909098: #5e5e6c;
    --c-808090: #66667a;
    --c-888: #6a6a78;
    --c-999: #76768a;
    --c-666: #7a7a88;
    --c-555: #80808e;
    --on: 0 0 0;
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]):not([data-theme="light"]) {
    --c-0e0e14: #e4e4ec;
    --c-111118: #eeeef3;
    --c-18181f: #f6f6fa;
    --c-1a1a2e: #fbfbfe;
    --c-1e1e2a: #ffffff;
    --c-1e1e2e: #ffffff;
    --c-ffffff: #1c1c24;
    --c-fff: #1c1c24;
    --c-f0f0ff: #1c1c24;
    --c-e0e0f0: #1c1c24;
    --c-e0e0e0: #1c1c24;
    --c-d8d8f0: #222230;
    --c-d0d0e8: #252533;
    --c-d0d0e0: #252533;
    --c-c0c0d8: #3a3a46;
    --c-c0c0d0: #3a3a46;
    --c-b8b8cc: #3a3a46;
    --c-b0b0c4: #42424e;
    --c-9090a8: #5e5e6c;
    --c-8a8aa0: #5e5e6c;
    --c-808098: #5e5e6c;
    --c-7a7a90: #66667a;
    --c-7a7a96: #66667a;
    --c-777790: #66667a;
    --c-707088: #66667a;
    --c-6a6a80: #74748a;
    --c-909098: #5e5e6c;
    --c-808090: #66667a;
    --c-888: #6a6a78;
    --c-999: #76768a;
    --c-666: #7a7a88;
    --c-555: #80808e;
    --on: 0 0 0;
  }"""

# Mocha (dark) : surfaces crust->surface0, texte text->overlay0
DARK = {
    "0e0e14": "#11111b",  # crust
    "111118": "#181825",  # mantle (body)
    "18181f": "#1e1e2e",  # base
    "1a1a2e": "#313244",  # surface0 (menus/popovers/toast)
    "1e1e2a": "#1e1e2e",  # base
    "1e1e2e": "#1e1e2e",  # base
    "ffffff": "#cdd6f4", "fff": "#cdd6f4", "f0f0ff": "#cdd6f4",
    "e0e0f0": "#cdd6f4", "e0e0e0": "#cdd6f4",            # text
    "d8d8f0": "#bac2de", "d0d0e8": "#bac2de", "d0d0e0": "#bac2de",  # subtext1
    "c0c0d8": "#a6adc8", "c0c0d0": "#a6adc8", "b8b8cc": "#a6adc8",
    "b0b0c4": "#a6adc8",                                  # subtext0
    "9090a8": "#9399b2", "8a8aa0": "#9399b2", "808098": "#9399b2",
    "909098": "#9399b2", "999": "#9399b2",                # overlay2
    "7a7a90": "#7f849c", "7a7a96": "#7f849c", "777790": "#7f849c",
    "707088": "#7f849c", "808090": "#7f849c", "888": "#7f849c",  # overlay1
    "6a6a80": "#6c7086", "666": "#6c7086", "555": "#6c7086",      # overlay0
}
# Latte (light) : surfaces base->crust, texte text->overlay0 (plus clairs = muted)
LIGHT = {
    "0e0e14": "#dce0e8",  # crust
    "111118": "#eff1f5",  # base (body)
    "18181f": "#eff1f5",  # base
    "1a1a2e": "#ccd0da",  # surface0
    "1e1e2a": "#eff1f5",
    "1e1e2e": "#eff1f5",
    "ffffff": "#4c4f69", "fff": "#4c4f69", "f0f0ff": "#4c4f69",
    "e0e0f0": "#4c4f69", "e0e0e0": "#4c4f69",            # text
    "d8d8f0": "#5c5f77", "d0d0e8": "#5c5f77", "d0d0e0": "#5c5f77",  # subtext1
    "c0c0d8": "#6c6f85", "c0c0d0": "#6c6f85", "b8b8cc": "#6c6f85",
    "b0b0c4": "#6c6f85",                                  # subtext0
    "9090a8": "#7c7f93", "8a8aa0": "#7c7f93", "808098": "#7c7f93",
    "909098": "#7c7f93", "999": "#7c7f93",                # overlay2
    "7a7a90": "#8c8fa1", "7a7a96": "#8c8fa1", "777790": "#8c8fa1",
    "707088": "#8c8fa1", "808090": "#8c8fa1", "888": "#8c8fa1",  # overlay1
    "6a6a80": "#9ca0b0", "666": "#9ca0b0", "555": "#9ca0b0",      # overlay0
}

VAR_ORDER = ["0e0e14", "111118", "18181f", "1a1a2e", "1e1e2a", "1e1e2e",
             "ffffff", "fff", "f0f0ff", "e0e0f0", "e0e0e0", "d8d8f0",
             "d0d0e8", "d0d0e0", "c0c0d8", "c0c0d0", "b8b8cc", "b0b0c4",
             "9090a8", "8a8aa0", "808098", "7a7a90", "7a7a96", "777790",
             "707088", "6a6a80", "909098", "808090", "888", "999", "666", "555"]

ACCENTS_DARK = """  /* Catppuccin Mocha accents */
  --accent: #b4befe; --accent-rgb: 180 190 254;  /* Lavender */
  --ok: #a6e3a1; --ok-rgb: 166 227 161;           /* Green */
  --warn: #fab387; --warn-rgb: 250 179 135;       /* Peach */
  --amber: #f9e2af; --amber-rgb: 249 226 175;     /* Yellow */
  --err: #f38ba8; --err-rgb: 243 139 168;         /* Red */
  --info: #89dceb; --info-rgb: 137 220 235;       /* Sky */
  --mauve: #cba6f7; --mauve-rgb: 203 166 247;     /* Mauve */"""

ACCENTS_LIGHT = """    /* Catppuccin Latte accents */
    --accent: #7287fd; --accent-rgb: 114 135 253;  /* Lavender */
    --ok: #40a02b; --ok-rgb: 64 160 43;            /* Green */
    --warn: #fe640b; --warn-rgb: 254 100 11;       /* Peach */
    --amber: #df8e1d; --amber-rgb: 223 142 29;     /* Yellow */
    --err: #d20f39; --err-rgb: 210 15 57;          /* Red */
    --info: #04a5e5; --info-rgb: 4 165 229;        /* Sky */
    --mauve: #8839ef; --mauve-rgb: 136 57 239;     /* Mauve */"""


def build_block(palette, indent, accents, comment, scheme):
    lines = [f"{indent}/* {comment} */"] if comment else []
    for v in VAR_ORDER:
        lines.append(f"{indent}--c-{v}: {palette[v]};")
    lines.append(f"{indent}--on: {scheme};")
    lines.append(accents)
    return "\n".join(lines)


def new_vars():
    dark = build_block(DARK, "  ", ACCENTS_DARK, MARKER, "255 255 255")
    light = build_block(LIGHT, "    ", ACCENTS_LIGHT,
                        "Catppuccin Latte surfaces/text", "0 0 0")
    return (
        ":root {\n  color-scheme: light dark;\n" + dark + "\n}\n"
        ':root[data-theme="dark"] { color-scheme: dark; }\n'
        ':root[data-theme="light"] { color-scheme: light; }\n\n'
        ':root[data-theme="light"] {\n' + light + "\n}\n\n"
        "@media (prefers-color-scheme: light) {\n"
        "  :root:not([data-theme=\"dark\"]):not([data-theme=\"light\"]) {\n"
        + light + "\n  }"
    )


# --- 2. Littéraux d'accent ----------------------------------------------------

# hex solide -> variable
HEX_MAP = {
    "8088ff": "accent", "6a72e0": "accent", "6068b0": "accent",
    "3ecf5a": "ok", "5ec46a": "ok", "60c060": "ok", "4a9": "ok",
    "e05070": "err", "e06060": "err", "ff6b6b": "err", "cc4444": "err",
    "ff5050": "err", "9b4058": "err",
    "f5be3c": "amber", "997a33": "amber",
    "e0a030": "warn", "e0a830": "warn", "f0a050": "warn",
    "4fc3f7": "info", "50b4ff": "info", "6cb6ff": "info", "8ccbff": "info",
    "80c0e0": "info", "40c8c8": "info",
    "c8b0e0": "mauve", "b0a0c0": "mauve",
}
# gris neutres résiduels (non couverts par le système --c-*) -> variable de
# surface/texte theme-aware la plus proche, pour qu'ils s'adaptent au mode clair.
NEUTRAL_MAP = {
    "8888a0": "c-808098", "8888a8": "c-808098",
    "606078": "c-6a6a80", "555570": "c-6a6a80", "5a5a70": "c-6a6a80",
    "606878": "c-6a6a80", "4a4a5a": "c-6a6a80",
    "9898b0": "c-9090a8", "a0a0b8": "c-9090a8",
    "c0c1d8": "c-c0c0d8", "b0b0d0": "c-b0b0c4", "b0b8c8": "c-b0b0c4",
    "5a7a6a": "c-7a7a90", "4a8a8a": "c-7a7a90",  # icônes menu -> neutre
}
# rgb triplet (sans alpha) -> variable
RGB_MAP = {
    (120, 130, 255): "accent", (128, 136, 255): "accent",
    (62, 207, 90): "ok", (100, 220, 120): "ok", (63, 185, 80): "ok",
    (224, 80, 112): "err", (255, 80, 80): "err", (255, 100, 100): "err",
    (248, 81, 73): "err",
    (240, 160, 80): "warn", (224, 160, 48): "warn", (255, 180, 50): "warn",
    (245, 190, 60): "amber", (255, 200, 50): "amber", (255, 190, 60): "amber",
    (80, 180, 255): "info", (79, 195, 247): "info", (64, 200, 200): "info",
    (200, 176, 224): "mauve",
}
# Bloc .markdown-preview : ces hex Dracula n'existent QUE là, on les remappe
# vers des variables Catppuccin theme-aware (surfaces/texte via --c-*, accents
# via --mauve/--info/--accent). Remplacement direct (sûr car uniques au bloc).
MD_MAP = {
    "#f8f8f2": "var(--c-e0e0e0)",   # corps du texte -> text
    "#bd93f9": "var(--mauve)",      # titres + th -> Mauve
    "#8be9fd": "var(--info)",       # liens -> Sky
    "#7aa2f7": "var(--accent)",     # code inline -> Lavender
    "#282a36": "var(--c-0e0e14)",   # fond bloc de code -> crust
    "#6272a4": "var(--c-7a7a90)",   # bordure blockquote -> overlay
}


def replace_accents(css):
    # rgba(R,G,B[,A]) -> rgb(var(--X-rgb) / A)  ou var(--X) si pas d'alpha
    def rgba_sub(m):
        r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
        var = RGB_MAP.get((r, g, b))
        if not var:
            return m.group(0)
        alpha = m.group(4)
        if alpha is None:
            return f"var(--{var})"
        return f"rgb(var(--{var}-rgb) / {alpha})"

    css = re.sub(
        r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)",
        rgba_sub, css)

    # hex solides : accents (HEX_MAP) + gris neutres (NEUTRAL_MAP)
    def hex_sub(m):
        h = m.group(1).lower()
        if h in HEX_MAP:
            return f"var(--{HEX_MAP[h]})"
        if h in NEUTRAL_MAP:
            return f"var(--{NEUTRAL_MAP[h]})"
        return m.group(0)

    # \b ne marche pas après #, on borne manuellement (pas suivi d'un hex digit)
    css = re.sub(r"#([0-9a-fA-F]{3,6})(?![0-9a-fA-F])", hex_sub, css)

    # bloc markdown-preview : remplacements directs
    for hexv, var in MD_MAP.items():
        css = css.replace(hexv, var)

    # corrections contextuelles : texte clair Catppuccin codé en dur en usage
    # `color:` (invisible en Latte). Les définitions `--c-*: #cdd6f4;` ont le
    # préfixe `--c-`, donc épargnées par ce remplacement ciblé sur `color:`.
    css = css.replace("color: #cdd6f4;", "color: var(--c-e0e0e0);")
    return css


def main():
    css = CSS.read_text()
    if MARKER in css:
        # déjà appliqué : on rejoue seulement les accents (idempotent) au cas où
        # un rebase aurait réintroduit des littéraux, puis on sort.
        print("Marqueur présent : variables déjà en Catppuccin.")
    else:
        if OLD_VARS not in css:
            print("ERREUR: bloc de variables introuvable (déjà modifié ?). "
                  "Abandon.", file=sys.stderr)
            return 1
        css = css.replace(OLD_VARS, new_vars())
        print("Variables remappées en Catppuccin (Mocha/Latte) + accents injectés.")

    css = replace_accents(css)
    CSS.write_text(css)
    print("Littéraux d'accent remappés vers var(--accent|ok|warn|amber|err|info|mauve).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
