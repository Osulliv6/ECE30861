// WCAG 2.1 contrast math: relative luminance and contrast ratio.
// https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio

const NAMED = {black:'#000000',white:'#ffffff',red:'#ff0000',green:'#008000',blue:'#0000ff',gray:'#808080',grey:'#808080',silver:'#c0c0c0',yellow:'#ffff00',orange:'#ffa500',purple:'#800080',navy:'#000080',maroon:'#800000',teal:'#008080',olive:'#808000',lime:'#00ff00',aqua:'#00ffff',fuchsia:'#ff00ff'};

// Accepts #rgb, #rrggbb, rgb(r,g,b), {r,g,b}, or a basic CSS color name. Returns {r,g,b} (0-255) or null.
export function parseColor(value) {
  if (value && typeof value === 'object') {
    const {r,g,b} = value;
    return [r,g,b].every(c=>Number.isFinite(c) && c>=0 && c<=255) ? {r,g,b} : null;
  }
  if (typeof value !== 'string') return null;
  let v = value.trim().toLowerCase();
  v = NAMED[v] || v;
  let m = v.match(/^#([0-9a-f]{3})$/);
  if (m) v = '#' + [...m[1]].map(c=>c+c).join('');
  m = v.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (m) return {r:parseInt(m[1],16),g:parseInt(m[2],16),b:parseInt(m[3],16)};
  m = v.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/);
  if (m) {
    const [r,g,b] = m.slice(1,4).map(Number);
    return [r,g,b].every(c=>c<=255) ? {r,g,b} : null;
  }
  return null;
}

export function relativeLuminance({r,g,b}) {
  const lin = c => { c /= 255; return c <= 0.03928 ? c/12.92 : ((c+0.055)/1.055) ** 2.4; };
  return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
}

export function contrastRatio(fg, bg) {
  const [hi,lo] = [relativeLuminance(fg),relativeLuminance(bg)].sort((a,b)=>b-a);
  return (hi+0.05)/(lo+0.05);
}

// WCAG "large text": at least 18pt, or at least 14pt and bold.
export function isLargeText({font_size_pt, bold}) {
  return Number.isFinite(font_size_pt) && (font_size_pt >= 18 || (bold === true && font_size_pt >= 14));
}
