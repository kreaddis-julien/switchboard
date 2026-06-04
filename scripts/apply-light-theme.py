#!/usr/bin/env python3
"""
apply-light-theme.py — patch local re-executable : ajoute un mode CLAIR a
Switchboard qui suit automatiquement l'apparence macOS (prefers-color-scheme).

Principe :
- Le mode SOMBRE reste strictement identique (les valeurs sombres des tokens =
  les valeurs codees en dur actuelles).
- On tokenise uniquement les FONDS, le TEXTE neutre et les OVERLAYS blancs.
  Les couleurs saturees (accent indigo, statuts vert/rouge/ambre/cyan, editeur
  dracula) sont laissees telles quelles : lisibles sur clair comme sur sombre.
- Les 135 overlays rgba(255,255,255,A) -> rgb(var(--on) / A), un seul flip
  255->0 bascule tous les overlays "eclaircissants" en "assombrissants".

Idempotent : sauvegarde public/style.css.orig au 1er run, repart toujours de
.orig. Ré-exécutable après un git pull.

Usage : python3 scripts/apply-light-theme.py [--revert]

Mise a jour apres un pull upstream qui modifie style.css :
  git checkout origin/main -- public/style.css   # recupere le pristine upstream
  cp public/style.css public/style.css.orig      # refait la reference pristine
  python3 scripts/apply-light-theme.py           # re-applique le patch CSS
(les modifs JS/HTML de la feature appearance se rebasent normalement.)
"""
import re
import sys
from pathlib import Path

CSS = Path(__file__).resolve().parent.parent / "public" / "style.css"
ORIG = CSS.with_suffix(".css.orig")

# Mapping : hex sombre d'origine -> valeur CLAIRE choisie.
# Token unique derive du hex (--c-XXXXXX) : la valeur SOMBRE du token = le hex
# lui-meme -> mode sombre strictement byte-identique. Seul le clair est nouveau.

# --- Fonds : ordre d'elevation conserve (en clair, surfaces hautes plus blanches) ---
BG = {
    "#0e0e14": "#e4e4ec",
    "#111118": "#eeeef3",
    "#18181f": "#f6f6fa",
    "#1a1a2e": "#fbfbfe",
    "#1e1e2a": "#ffffff",
    "#1e1e2e": "#ffffff",
}

# --- Texte neutre : clair vif -> quasi noir ; gris -> gris fonce ---
TEXT = {
    "#ffffff": "#1c1c24",
    "#fff":    "#1c1c24",
    "#f0f0ff": "#1c1c24",
    "#e0e0f0": "#1c1c24",
    "#e0e0e0": "#1c1c24",
    "#d8d8f0": "#222230",
    "#d0d0e8": "#252533",
    "#d0d0e0": "#252533",
    "#c0c0d8": "#3a3a46",
    "#c0c0d0": "#3a3a46",
    "#b8b8cc": "#3a3a46",
    "#b0b0c4": "#42424e",
    "#9090a8": "#5e5e6c",
    "#8a8aa0": "#5e5e6c",
    "#808098": "#5e5e6c",
    "#7a7a90": "#66667a",
    "#7a7a96": "#66667a",
    "#777790": "#66667a",
    "#707088": "#66667a",
    "#6a6a80": "#74748a",
    "#909098": "#5e5e6c",
    "#808090": "#66667a",
    "#888":    "#6a6a78",
    "#999":    "#76768a",
    "#666":    "#7a7a88",
    "#555":    "#80808e",
}


def tok_for(hexv: str) -> str:
    """Token unique par hex : #1a2b3c -> --c-1a2b3c, #fff -> --c-fff."""
    return "--c-" + hexv.lstrip("#").lower()

MARKER = "/* light-theme-auto: applied */"


def build_root_blocks():
    """Tokens sombres (= valeurs d'origine) + variantes claires.

    Trois modes pilotes par l'attribut data-theme sur <html> :
    - absent / "auto" -> suit prefers-color-scheme (OS, dont le mode auto macOS)
    - "light"         -> force le clair
    - "dark"          -> force le sombre (= :root par defaut)
    """
    dark, light = {}, {}
    for hexv, lightv in {**BG, **TEXT}.items():
        tok = tok_for(hexv)
        dark[tok] = hexv          # valeur sombre = hex d'origine -> sombre identique
        light[tok] = lightv
    dark["--on"], light["--on"] = "255 255 255", "0 0 0"

    dark_vars = "\n".join(f"  {k}: {v};" for k, v in dark.items())
    light_vars = "\n".join(f"    {k}: {v};" for k, v in light.items())

    return (
        f"{MARKER}\n"
        # defaut = sombre + color-scheme auto (controles natifs/scrollbars suivent l'OS)
        f":root {{\n  color-scheme: light dark;\n{dark_vars}\n}}\n"
        f":root[data-theme=\"dark\"] {{ color-scheme: dark; }}\n"
        f":root[data-theme=\"light\"] {{ color-scheme: light; }}\n\n"
        # clair force
        f":root[data-theme=\"light\"] {{\n{light_vars}\n}}\n\n"
        # auto : suit l'OS, sauf si un mode est force explicitement
        f"@media (prefers-color-scheme: light) {{\n"
        f"  :root:not([data-theme=\"dark\"]):not([data-theme=\"light\"]) {{\n{light_vars}\n  }}\n"
        f"}}\n\n"
    )


def apply(css: str) -> str:
    # 1) overlays blancs -> rgb(var(--on) / A)
    css = re.sub(
        r"rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)",
        lambda m: f"rgb(var(--on) / {m.group(1)})",
        css,
    )

    # 2) hex (fonds + texte) -> var(--token), via callback (evite les sous-chaines)
    hexmap = {hexv.lower(): tok_for(hexv) for hexv in {**BG, **TEXT}}

    def repl_hex(m):
        tok = hexmap.get(m.group(0).lower())
        return f"var({tok})" if tok else m.group(0)

    css = re.sub(r"#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b", repl_hex, css)

    # 3) prepend des blocs :root + media
    return build_root_blocks() + css


def main():
    if not CSS.exists():
        sys.exit(f"introuvable: {CSS}")

    # Garde-fou : si style.css est deja patche mais que .orig (la reference
    # pristine) manque, on NE backupe PAS le fichier patche (ca corromprait la
    # reference). On exige de fournir le pristine d'abord.
    if not ORIG.exists():
        if MARKER in CSS.read_text(encoding="utf-8"):
            sys.exit(
                "style.css est deja patche mais public/style.css.orig (pristine) manque.\n"
                "Recupere le style.css upstream puis copie-le en .orig :\n"
                "  git checkout origin/main -- public/style.css\n"
                "  cp public/style.css public/style.css.orig\n"
                "  python3 scripts/apply-light-theme.py"
            )
        ORIG.write_text(CSS.read_text(), encoding="utf-8")
        print(f"backup cree: {ORIG.name}")

    base = ORIG.read_text(encoding="utf-8")

    if "--revert" in sys.argv:
        CSS.write_text(base, encoding="utf-8")
        print("revert: style.css restaure depuis .orig")
        return

    CSS.write_text(apply(base), encoding="utf-8")
    print("applique: mode clair auto (prefers-color-scheme) injecte dans style.css")


if __name__ == "__main__":
    main()
