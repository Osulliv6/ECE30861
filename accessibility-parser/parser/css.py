"""Resolve the CSS that affects text contrast in an uploaded HTML document.

Implements the part of the CSS cascade the accessibility checks need: embedded
<style> sheets and inline style attributes, selector specificity, source order,
!important, inheritance of color / font-size / font-weight, and the effective
background behind an element (the nearest ancestor background, composited when
semi-transparent).

Deliberately not supported, so results are "unknown" rather than guessed:
external stylesheets (the service never fetches URLs from uploads), conditional
@media / @supports blocks, CSS custom properties (var()), background images and
gradients, pseudo-elements, and layout-dependent effects such as positioning.
"""
from __future__ import annotations

import colorsys
import re
from typing import Any

# ---- Colors ------------------------------------------------------------------------------

NAMED_COLORS = {
    'black': '000000', 'white': 'ffffff', 'red': 'ff0000', 'green': '008000', 'blue': '0000ff',
    'gray': '808080', 'grey': '808080', 'silver': 'c0c0c0', 'yellow': 'ffff00', 'orange': 'ffa500',
    'purple': '800080', 'navy': '000080', 'maroon': '800000', 'teal': '008080', 'olive': '808000',
    'lime': '00ff00', 'aqua': '00ffff', 'cyan': '00ffff', 'fuchsia': 'ff00ff', 'magenta': 'ff00ff',
    'darkgray': 'a9a9a9', 'darkgrey': 'a9a9a9', 'dimgray': '696969', 'dimgrey': '696969',
    'lightgray': 'd3d3d3', 'lightgrey': 'd3d3d3', 'gainsboro': 'dcdcdc', 'whitesmoke': 'f5f5f5',
    'slategray': '708090', 'lightslategray': '778899', 'darkslategray': '2f4f4f',
    'darkblue': '00008b', 'darkred': '8b0000', 'darkgreen': '006400', 'lightblue': 'add8e6',
    'lightgreen': '90ee90', 'lightyellow': 'ffffe0', 'pink': 'ffc0cb', 'gold': 'ffd700',
    'beige': 'f5f5dc', 'ivory': 'fffff0', 'khaki': 'f0e68c', 'tan': 'd2b48c', 'brown': 'a52a2a',
    'crimson': 'dc143c', 'tomato': 'ff6347', 'coral': 'ff7f50', 'salmon': 'fa8072',
    'skyblue': '87ceeb', 'steelblue': '4682b4', 'royalblue': '4169e1', 'indigo': '4b0082',
    'violet': 'ee82ee', 'orchid': 'da70d6', 'plum': 'dda0dd', 'lavender': 'e6e6fa',
    'aliceblue': 'f0f8ff', 'honeydew': 'f0fff0', 'mintcream': 'f5fffa', 'azure': 'f0ffff',
    'snow': 'fffafa', 'seashell': 'fff5ee', 'linen': 'faf0e6', 'oldlace': 'fdf5e6',
    'floralwhite': 'fffaf0', 'ghostwhite': 'f8f8ff', 'cornsilk': 'fff8dc', 'wheat': 'f5deb3',
    'lightcyan': 'e0ffff', 'lightpink': 'ffb6c1', 'darkorange': 'ff8c00', 'goldenrod': 'daa520',
    'darkgoldenrod': 'b8860b', 'chocolate': 'd2691e', 'firebrick': 'b22222', 'olivedrab': '6b8e23',
    'forestgreen': '228b22', 'seagreen': '2e8b57', 'midnightblue': '191970', 'darkslateblue': '483d8b',
}

_NUM = r'([+-]?(?:\d+\.?\d*|\.\d+))'


def _channel(token: str, scale: float = 255) -> float | None:
    token = token.strip()
    try:
        if token.endswith('%'):
            return max(0.0, min(1.0, float(token[:-1]) / 100)) * scale
        return max(0.0, min(scale, float(token)))
    except ValueError:
        return None


def parse_color(value: Any) -> tuple[float, float, float, float] | None:
    """Return (r, g, b, alpha) with r/g/b in 0..255 and alpha in 0..1, or None if unknown."""
    if not isinstance(value, str):
        return None
    v = re.sub(r'\s*!important\s*$', '', value.strip().lower())
    if v == 'transparent':
        return (0, 0, 0, 0)
    if v in NAMED_COLORS:
        v = '#' + NAMED_COLORS[v]
    m = re.fullmatch(r'#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})', v)
    if m:
        h = m.group(1)
        if len(h) in (3, 4):
            h = ''.join(c * 2 for c in h)
        alpha = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), alpha)
    m = re.fullmatch(r'(rgba?|hsla?)\((.*)\)', v)
    if not m:
        return None
    parts = [p for p in re.split(r'[\s,/]+', m.group(2).strip()) if p]
    if len(parts) not in (3, 4):
        return None
    alpha = _channel(parts[3], 1) if len(parts) == 4 else 1.0
    if alpha is None:
        return None
    if m.group(1).startswith('rgb'):
        rgb = [_channel(p) for p in parts[:3]]
        if any(c is None for c in rgb):
            return None
        return (*rgb, alpha)
    try:
        hue = float(re.sub(r'deg$', '', parts[0])) % 360 / 360
    except ValueError:
        return None
    sat, light = _channel(parts[1], 1), _channel(parts[2], 1)
    if sat is None or light is None:
        return None
    r, g, b = colorsys.hls_to_rgb(hue, light, sat)
    return (r * 255, g * 255, b * 255, alpha)


def composite(fg: tuple, bg: tuple) -> tuple[float, float, float, float]:
    """Alpha-composite fg over an opaque bg."""
    a = fg[3]
    return (fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1.0)


def to_hex(color: tuple) -> str:
    return '#' + ''.join(f'{max(0, min(255, round(c))):02x}' for c in color[:3])


# WCAG 2.1 contrast, kept identical to engine/contrast.mjs (tests compare the two).
def relative_luminance(color: tuple) -> float:
    def lin(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(color[0]) + 0.7152 * lin(color[1]) + 0.0722 * lin(color[2])


def contrast_ratio(a: tuple, b: tuple) -> float:
    hi, lo = sorted([relative_luminance(a), relative_luminance(b)], reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def is_large_text(font_size_pt: float | None, bold: bool | None) -> bool:
    return font_size_pt is not None and (font_size_pt >= 18 or (bold is True and font_size_pt >= 14))


def required_ratio(font_size_pt: float | None, bold: bool | None) -> float:
    return 3.0 if is_large_text(font_size_pt, bold) else 4.5


def fix_contrast(fg: tuple, bg: tuple, required: float) -> tuple[float, float, float, float] | None:
    """Return the color closest to fg (same hue, blended toward black or white) that meets
    `required` against bg after rounding to hex, or None if neither direction can."""
    def blend(target, t):
        return tuple(round(fg[i] + (target[i] - fg[i]) * t) for i in range(3)) + (1.0,)
    options = []
    for target in ((0, 0, 0), (255, 255, 255)):
        if contrast_ratio(blend(target, 1), bg) < required:
            continue
        lo, hi = 0.0, 1.0
        for _ in range(30):
            mid = (lo + hi) / 2
            if contrast_ratio(blend(target, mid), bg) >= required:
                hi = mid
            else:
                lo = mid
        options.append((hi, blend(target, hi)))
    return min(options)[1] if options else None


# ---- Stylesheets ---------------------------------------------------------------------------

def _strip_comments(css: str) -> str:
    return re.sub(r'/\*.*?\*/', ' ', css, flags=re.S)


def _matching_brace(css: str, start: int) -> int:
    depth = 0
    for i in range(start, len(css)):
        if css[i] == '{':
            depth += 1
        elif css[i] == '}':
            depth -= 1
            if depth == 0:
                return i
    return len(css)


_UNCONDITIONAL_MEDIA = re.compile(r'^\s*(?:only\s+)?(?:all|screen)(?:\s*,\s*(?:only\s+)?(?:all|screen))*\s*$', re.I)


def parse_declarations(text: str) -> dict[str, tuple[str, bool]]:
    out = {}
    for decl in text.split(';'):
        if ':' not in decl:
            continue
        prop, value = decl.split(':', 1)
        prop, value = prop.strip().lower(), value.strip()
        important = bool(re.search(r'!\s*important\s*$', value, re.I))
        value = re.sub(r'\s*!\s*important\s*$', '', value, flags=re.I).strip()
        if prop and value:
            out[prop] = (value, important)
    return out


def parse_rules(css: str) -> list[tuple[str, dict]]:
    """Return (selector_list, declarations) pairs in source order. Unconditional @media
    screen/all blocks are flattened; every other at-rule is skipped."""
    css = _strip_comments(css)
    rules, i = [], 0
    while i < len(css):
        brace = css.find('{', i)
        if brace < 0:
            break
        prelude = css[i:brace].strip()
        # A statement at-rule such as @import or @charset ends at ';' before any block.
        while prelude.startswith('@') and ';' in prelude:
            prelude = prelude.split(';', 1)[1].strip()
        end = _matching_brace(css, brace)
        body = css[brace + 1:end]
        if prelude.startswith('@'):
            media = re.match(r'@media\s+(.*)$', prelude, re.I | re.S)
            if media and _UNCONDITIONAL_MEDIA.match(media.group(1)):
                rules.extend(parse_rules(body))
        elif prelude:
            rules.append((prelude, parse_declarations(body)))
        i = end + 1
    return rules


def specificity(selector: str) -> tuple[int, int, int]:
    s = re.sub(r'"[^"]*"|\'[^\']*\'', '', selector)
    s = re.sub(r':(?:not|is|has)\(', ' ', s)  # count the argument, not the wrapper
    s = re.sub(r':where\([^)]*\)', '', s)
    ids = len(re.findall(r'#[\w-]+', s))
    classes = len(re.findall(r'\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+', s))
    s = re.sub(r'#[\w-]+|\.[\w-]+|\[[^\]]*\]|:+[\w-]+(\([^)]*\))?', ' ', s)
    types = len(re.findall(r'(?:^|[\s>+~(])([a-zA-Z][\w-]*)', s))
    pseudo_elements = len(re.findall(r'::[\w-]+', selector))
    return (ids, classes, types + pseudo_elements)


_DYNAMIC = re.compile(r'::|:(?:hover|focus|focus-within|focus-visible|active|visited|target|checked)\b', re.I)

# User-agent defaults that matter for contrast: headings and strong text are bold, and
# headings are larger (CSS 2.1 / HTML Living Standard rendering section).
UA_FONT_SIZE_EM = {'h1': 2.0, 'h2': 1.5, 'h3': 1.17, 'h4': 1.0, 'h5': 0.83, 'h6': 0.67, 'small': 0.83}
UA_BOLD = {'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'strong', 'th'}
FONT_SIZE_KEYWORDS_PX = {'xx-small': 9, 'x-small': 10, 'small': 13, 'medium': 16, 'large': 18,
                         'x-large': 24, 'xx-large': 32, 'xxx-large': 48}
DEFAULT_FONT_PX = 16.0
WHITE = (255, 255, 255, 1.0)


class StyleResolver:
    """Computes the contrast-relevant style of any element in a BeautifulSoup tree.

    Build it before <style> elements are removed from the tree."""

    MAX_RULES = 5000

    def __init__(self, soup):
        self._declared: dict[int, list] = {}
        self._cache: dict[tuple[int, str], Any] = {}
        self.external_stylesheets = len([l for l in soup.find_all('link')
                                         if 'stylesheet' in [r.lower() for r in (l.get('rel') or [])]])
        self.skipped_selectors = 0
        order = 0
        for style in soup.find_all('style'):
            media = (style.get('media') or 'all').strip()
            if not _UNCONDITIONAL_MEDIA.match(media):
                continue
            for selectors, decls in parse_rules(style.get_text())[:self.MAX_RULES]:
                for selector in selectors.split(','):
                    selector = selector.strip()
                    order += 1
                    if not selector or _DYNAMIC.search(selector):
                        continue
                    try:
                        matched = soup.select(selector)
                    except Exception:  # selector syntax soupsieve does not support
                        self.skipped_selectors += 1
                        continue
                    spec = specificity(selector)
                    for tag in matched:
                        self._declared.setdefault(id(tag), []).append((spec, order, decls))

    # The cascaded (declared) value of one property on one element, or None.
    def declared(self, tag, prop: str) -> tuple[str, bool] | None:
        key = (id(tag), 'decl:' + prop)
        if key in self._cache:
            return self._cache[key]
        best, best_key = None, None
        for spec, order, decls in self._declared.get(id(tag), []):
            if prop in decls:
                value, important = decls[prop]
                rank = (important, 0, spec, order)
                if best_key is None or rank > best_key:
                    best, best_key = (value, important), rank
        inline = parse_declarations(tag.get('style', '') if hasattr(tag, 'get') else '').get(prop)
        if inline is not None:
            rank = (inline[1], 1, (0, 0, 0), 0)
            if best_key is None or rank > best_key:
                best = inline
        self._cache[key] = best
        return best

    def _parent(self, tag):
        parent = tag.parent
        return parent if parent is not None and getattr(parent, 'name', None) not in (None, '[document]') else None

    def color(self, tag) -> tuple | None:
        """Computed foreground color, or None when only the browser default (black) applies.
        Returns False when the color is set but cannot be evaluated."""
        key = (id(tag), 'color')
        if key in self._cache:
            return self._cache[key]
        decl = self.declared(tag, 'color')
        value = decl[0].strip().lower() if decl else None
        if value is None or value in ('inherit', 'unset'):
            parent = self._parent(tag)
            result = self.color(parent) if parent is not None else None
        elif value in ('initial', 'revert'):
            result = None
        else:
            result = parse_color(value) or False
        self._cache[key] = result
        return result

    def _own_background(self, tag):
        """This element's own background layer: a color tuple, None (transparent), or False (unknown)."""
        image = self.declared(tag, 'background-image')
        if image and image[0].strip().lower() not in ('none', 'initial', 'unset'):
            return False
        shorthand = self.declared(tag, 'background')
        longhand = self.declared(tag, 'background-color')
        chosen = None
        if shorthand and longhand:
            # The later/more specific one wins; approximate by preferring importance, then the longhand.
            chosen = ('short', shorthand) if shorthand[1] and not longhand[1] else ('long', longhand)
        elif shorthand:
            chosen = ('short', shorthand)
        elif longhand:
            chosen = ('long', longhand)
        if not chosen:
            return None
        kind, (value, _) = chosen
        value = value.strip().lower()
        if value in ('inherit', 'initial', 'unset', 'none', 'transparent'):
            return None
        if kind == 'long':
            return parse_color(value) or False
        if re.search(r'url\(|gradient\(|image-set\(', value):
            return False
        colors = [c for c in (parse_color(tok) for tok in re.findall(r'#[0-9a-f]+|(?:rgba?|hsla?)\([^)]*\)|[a-z]+', value)) if c]
        return colors[-1] if colors else None

    def background(self, tag) -> tuple | None | bool:
        """Effective opaque background behind the element's text: a color, None when no
        ancestor sets one (the browser default white), or False when it cannot be determined."""
        key = (id(tag), 'background')
        if key in self._cache:
            return self._cache[key]
        own = self._own_background(tag)
        parent = self._parent(tag)
        if own is False:
            result = False
        elif own is None or own[3] < 1:
            below = self.background(parent) if parent is not None else None
            if own is None or own[3] == 0:
                result = below
            elif below is False:
                result = False
            else:
                result = composite(own, below or WHITE)
        else:
            result = own
        self._cache[key] = result
        return result

    def font_size_px(self, tag) -> float | None:
        key = (id(tag), 'size')
        if key in self._cache:
            return self._cache[key]
        parent = self._parent(tag)
        parent_px = self.font_size_px(parent) if parent is not None else DEFAULT_FONT_PX
        decl = self.declared(tag, 'font-size')
        result = parent_px
        if decl:
            value = decl[0].strip().lower()
            m = re.fullmatch(_NUM + r'(px|pt|em|rem|%)', value)
            if parent_px is None and m and m.group(2) in ('em', '%'):
                result = None
            elif m:
                n, unit = float(m.group(1)), m.group(2)
                result = {'px': n, 'pt': n * 4 / 3, 'em': n * (parent_px or 0), 'rem': n * DEFAULT_FONT_PX,
                          '%': n / 100 * (parent_px or 0)}[unit]
            elif value in FONT_SIZE_KEYWORDS_PX:
                result = float(FONT_SIZE_KEYWORDS_PX[value])
            elif value in ('smaller', 'larger') and parent_px is not None:
                result = parent_px * (0.83 if value == 'smaller' else 1.2)
            elif value not in ('inherit', 'unset'):
                result = None  # calc(), viewport units, etc.
        elif tag.name in UA_FONT_SIZE_EM and parent_px is not None:
            result = parent_px * UA_FONT_SIZE_EM[tag.name]
        self._cache[key] = result
        return result

    def bold(self, tag) -> bool:
        key = (id(tag), 'bold')
        if key in self._cache:
            return self._cache[key]
        parent = self._parent(tag)
        decl = self.declared(tag, 'font-weight')
        value = decl[0].strip().lower() if decl else None
        if value is None:
            result = tag.name in UA_BOLD or (parent is not None and self.bold(parent))
        elif value in ('inherit', 'unset'):
            result = parent is not None and self.bold(parent)
        elif value in ('bold', 'bolder'):
            result = True
        elif value.isdigit():
            result = int(value) >= 600
        else:
            result = False
        self._cache[key] = result
        return result

    def hidden(self, tag) -> bool:
        node = tag
        while node is not None:
            display = self.declared(node, 'display')
            if display and display[0].strip().lower() == 'none':
                return True
            if node.has_attr('hidden'):
                return True
            node = self._parent(node)
        visibility = None
        node = tag
        while node is not None and visibility is None:
            decl = self.declared(node, 'visibility')
            visibility = decl[0].strip().lower() if decl and decl[0].strip().lower() not in ('inherit', 'unset') else None
            node = self._parent(node)
        return visibility in ('hidden', 'collapse')

    def text_style(self, tag) -> dict[str, Any]:
        """Fields for the engine's text-bearing elements (color, background, font_size_pt, bold)."""
        out: dict[str, Any] = {}
        size = self.font_size_px(tag)
        if size is not None:
            out['font_size_pt'] = round(size * 0.75, 2)
        if self.bold(tag):
            out['bold'] = True
        if self.hidden(tag):
            return out  # Invisible text has no contrast requirement.
        fg, bg = self.color(tag), self.background(tag)
        if fg is False or bg is False:
            out['contrast_unknown'] = True
            return out
        if fg is None and bg is None:
            return out  # Browser defaults: black on white.
        base = bg or WHITE
        fg = fg or (0, 0, 0, 1.0)
        out['color'] = to_hex(composite(fg, base) if fg[3] < 1 else fg)
        if bg is not None:
            out['background'] = to_hex(bg)
        return out
