// submit-chars.js — detect/strip characters that a terminal might treat as
// an Enter/submit when text is typed into a PTY. Agent-derived strings
// (initialPrompt, blockedReason, failReason) flow into the master/worker
// terminals, so a stray newline or Unicode line separator could submit an
// extra prompt. Implemented with charCode checks (not a regex literal) so
// the dangerous code points never appear verbatim in source.
//
// Covered: C0 controls 0x00–0x1F, DEL 0x7F, NEL 0x85, line separator
// 0x2028, paragraph separator 0x2029. Tab (0x09) and newline (0x0A) and
// carriage return (0x0D) are treated as submit-class here for the strict
// callers; callers that legitimately allow \n/\t pass `allow`.

const NEL = 0x85;
const LINE_SEP = 0x2028;
const PARA_SEP = 0x2029;

function isSubmitCode(code, allowTab, allowNewline) {
  if (code === 0x09) return !allowTab ? true : false;
  if (code === 0x0a || code === 0x0d) return !allowNewline ? true : false;
  if (code <= 0x1f) return true;          // other C0 controls
  if (code === 0x7f) return true;         // DEL
  if (code === NEL) return true;          // NEL
  if (code === LINE_SEP || code === PARA_SEP) return true;
  return false;
}

// True if `s` contains any submit-class char. By default tabs and newlines
// are NOT allowed (strict — used for single-line prompts). Pass
// {allowTab, allowNewline} to relax.
function hasSubmitChars(s, { allowTab = false, allowNewline = false } = {}) {
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    if (isSubmitCode(str.charCodeAt(i), allowTab, allowNewline)) return true;
  }
  return false;
}

// Replace runs of submit-class chars with a single space (always strict —
// nudge lines are single-line).
function stripSubmitChars(s) {
  const str = String(s);
  let out = '';
  let prevStripped = false;
  for (let i = 0; i < str.length; i++) {
    if (isSubmitCode(str.charCodeAt(i), false, false)) {
      if (!prevStripped) out += ' ';
      prevStripped = true;
    } else {
      out += str[i];
      prevStripped = false;
    }
  }
  return out;
}

module.exports = { hasSubmitChars, stripSubmitChars, isSubmitCode };
