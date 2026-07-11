// contentType.js
//
// Pure helpers (no GObject, no platform deps) that classify a clipboard text
// item into a coarse subtype, so the popup can show a fitting icon/swatch and
// offer a SAFE action (open a link or a mailto). Detection is best-effort and
// intentionally conservative; it never runs anything on its own.

const URL_RE = /^(https?:\/\/|www\.)[^\s]+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Strict on purpose: colorValue() is interpolated into an inline St style (the
// swatch's background-color), so the value must never be able to smuggle extra
// CSS declarations — no ';', letters or parens inside rgb()/rgba().
const COLOR_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$|^rgba?\([\d.,%\s/]+\)$/i;

// Returns 'url' | 'color' | 'email' | 'code' | null.
export function detectSubtype(text) {
    if (typeof text !== 'string')
        return null;
    const t = text.trim();
    if (!t || t.length > 2048)
        return null; // don't classify very long blobs
    if (URL_RE.test(t))
        return 'url';
    if (EMAIL_RE.test(t))
        return 'email';
    if (COLOR_RE.test(t))
        return 'color';
    if (looksLikeCode(t))
        return 'code';
    return null;
}

function looksLikeCode(t) {
    if (!t.includes('\n'))
        return false;
    // A few cheap signals; this only drives an icon, never an action.
    return /[{};]\s*$/m.test(t) ||
        /^\s*(function|class|const|let|var|import|export|def|public|private)\b/m.test(t) ||
        /=>/.test(t);
}

// A CSS color string for a 'color' item, or null.
export function colorValue(text) {
    const t = text.trim();
    return COLOR_RE.test(t) ? t : null;
}

// The safe URI to open for an actionable subtype ('url'/'email'), or null.
export function actionUri(subtype, text) {
    const t = text.trim();
    if (subtype === 'url')
        return /^www\./i.test(t) ? `https://${t}` : t;
    if (subtype === 'email')
        return `mailto:${t}`;
    return null;
}

// The content type used to look up the apps that can open an item, so the popup
// can offer an "Open with…" chooser. Returns a scheme handler type for
// url/email (e.g. browsers, mail clients), or null when nothing safe applies.
export function openWithType(subtype, text) {
    if (subtype === 'url') {
        const scheme = /^http:\/\//i.test(text.trim()) ? 'http' : 'https';
        return `x-scheme-handler/${scheme}`;
    }
    if (subtype === 'email')
        return 'x-scheme-handler/mailto';
    return null;
}
