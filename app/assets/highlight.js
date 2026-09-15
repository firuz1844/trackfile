/* Small dependency-free syntax highlighter for the source reader. Regex tokenizers per language,
 * DOM output only (spans with classes), no innerHTML. Covers what this repository contains. */
(function (root) {
  'use strict';
  const kw = words => new RegExp('\\b(?:' + words.trim().split(/\s+/).join('|') + ')\\b', 'y');
  const common = {
    number: /\b(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b/y,
    dqString: /"(?:[^"\\\n]|\\.)*"/y,
    sqString: /'(?:[^'\\\n]|\\.)*'/y,
    lineComment: /\/\/.*/y,
    blockComment: /\/\*[\s\S]*?(?:\*\/|$)/y,
    hashComment: /#.*/y
  };
  const languages = {
    swift: [
      ['comment', common.blockComment], ['comment', common.lineComment],
      ['string', /"""[\s\S]*?"""/y], ['string', /#*"(?:[^"\\\n]|\\.)*"#*/y],
      ['attribute', /@[A-Za-z_]\w*/y], ['preprocessor', /#(?:if|else|elseif|endif|available|selector|keyPath|warning|error|file|line|function)\b/y],
      ['keyword', kw(`associatedtype class deinit enum extension func import init inout internal let operator private fileprivate open protocol public static struct subscript typealias var actor async await break case continue default defer do else fallthrough for guard if in repeat return switch where while as is nil rethrows super self Self throw throws try true false catch some any macro consuming borrowing nonisolated isolated convenience dynamic final indirect lazy mutating nonmutating optional override required unowned weak willSet didSet get set`)],
      ['type', /\b[A-Z][A-Za-z0-9_]*\b/y], ['number', common.number],
      ['function', /\b[a-z_]\w*(?=\s*\()/y]
    ],
    bash: [
      ['comment', common.hashComment], ['string', /"(?:[^"\\]|\\[\s\S])*"/y], ['string', common.sqString],
      ['variable', /\$(?:\{[^}]*\}|[A-Za-z_]\w*|[@#?$!0-9*-])/y],
      ['keyword', kw(`if then else elif fi for while until do done case esac in function select time return exit break continue local export readonly declare set unset shift source trap eval exec`)],
      ['builtin', kw(`echo printf cd pwd test read let true false node npm git curl open exec sed awk grep find xargs mkdir rm cp mv cat chmod command`)],
      ['number', common.number]
    ],
    javascript: [
      ['comment', common.blockComment], ['comment', common.lineComment],
      ['string', /`(?:[^`\\]|\\[\s\S])*`/y], ['string', common.dqString], ['string', common.sqString],
      ['regex', /\/(?![*/])(?:[^\/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[gimsuyd]*(?=\s*[.,;)\]}\n]|\s*$)/y],
      ['keyword', kw(`async await break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield true false null undefined get set`)],
      ['type', /\b[A-Z][A-Za-z0-9_]*\b/y], ['number', common.number], ['function', /\b[a-zA-Z_$][\w$]*(?=\s*\()/y]
    ],
    json: [['property', /"(?:[^"\\]|\\.)*"(?=\s*:)/y], ['string', common.dqString], ['keyword', kw('true false null')], ['number', /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y]],
    yaml: [
      ['comment', common.hashComment], ['property', /^[ \t]*-?[ \t]*[A-Za-z_][\w. -]*(?=:(?:\s|$))/my], ['string', common.dqString], ['string', common.sqString],
      ['keyword', kw('true false null yes no on off ~')], ['number', common.number], ['punctuation', /^[ \t]*-(?=\s)/my], ['tag', /[&*][\w-]+|!![\w]+/y]
    ],
    toml: [['comment', common.hashComment], ['section', /^\s*\[\[?[^\]]+\]\]?/my], ['property', /^\s*[\w.-]+(?=\s*=)/my], ['string', /"""[\s\S]*?"""|'''[\s\S]*?'''/y], ['string', common.dqString], ['string', common.sqString], ['keyword', kw('true false')], ['number', common.number]],
    css: [
      ['comment', common.blockComment], ['string', common.dqString], ['string', common.sqString],
      ['atrule', /@[\w-]+/y], ['selector', /(?:^|(?<=[}\n]))\s*[^{}\/;]+?(?=\s*\{)/y], ['property', /[\w-]+(?=\s*:)/y],
      ['variable', /--[\w-]+/y], ['number', /-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?/y], ['color', /#[\da-fA-F]{3,8}\b/y], ['function', /[\w-]+(?=\()/y]
    ],
    html: [
      ['comment', /<!--[\s\S]*?-->/y], ['doctype', /<!doctype[^>]*>/iy],
      ['tag', /<\/?[A-Za-z][\w:-]*/y], ['tag', /\/?>/y],
      ['attribute', /(?<=<[^>]*?\s)[A-Za-z_:][\w:.-]*(?=\s*=|\s|\/?>)/y], ['string', common.dqString], ['string', common.sqString]
    ],
    python: [
      ['comment', common.hashComment], ['string', /(?:[rRbBfFuU]{0,2})(?:"""[\s\S]*?"""|'''[\s\S]*?''')/y], ['string', common.dqString], ['string', common.sqString],
      ['decorator', /@[\w.]+/y],
      ['keyword', kw(`and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self`)],
      ['type', /\b[A-Z][A-Za-z0-9_]*\b/y], ['number', common.number], ['function', /\b[a-zA-Z_]\w*(?=\s*\()/y]
    ],
    markdown: [['heading', /^#{1,6} .*/my], ['comment', /^```.*$/my], ['string', /`[^`\n]+`/y], ['keyword', /\*\*[^*\n]+\*\*/y], ['link', /\[[^\]\n]*\]\([^)\n]*\)/y], ['punctuation', /^\s*(?:[-*+]|\d+\.)(?=\s)/my]]
  };
  const aliases = { sh: 'bash', zsh: 'bash', shell: 'bash', js: 'javascript', cjs: 'javascript', mjs: 'javascript', ts: 'javascript', typescript: 'javascript', jsonc: 'json', yml: 'yaml', xml: 'html', htm: 'html', svg: 'html', plist: 'html', entitlements: 'html', py: 'python', md: 'markdown', markdown: 'markdown', command: 'bash' };
  const byExtension = { swift: 'swift', sh: 'bash', command: 'bash', js: 'javascript', cjs: 'javascript', mjs: 'javascript', ts: 'javascript', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', css: 'css', html: 'html', htm: 'html', xml: 'html', plist: 'html', entitlements: 'html', svg: 'html', py: 'python', md: 'markdown', markdown: 'markdown' };
  const resolve = name => { const n = (name || '').toLowerCase(); return languages[n] ? n : languages[aliases[n]] ? aliases[n] : null; };
  const languageFor = path => byExtension[(path.split('.').pop() || '').toLowerCase()] ?? null;

  // Returns [{cls, text}] covering the whole input; unmatched characters are merged into cls null runs.
  function tokenize(text, language) {
    const rules = languages[resolve(language)];
    const out = [];
    const push = (cls, str) => { const last = out.at(-1); if (last && last.cls === cls) last.text += str; else out.push({ cls, text: str }); };
    if (!rules) return [{ cls: null, text }];
    let i = 0;
    while (i < text.length) {
      let hit = null;
      for (const [cls, re] of rules) {
        re.lastIndex = i;
        const m = re.exec(text);
        if (m && m.index === i && m[0].length) { hit = [cls, m[0]]; break; }
      }
      if (hit) { push(hit[0], hit[1]); i += hit[1].length; } else { push(null, text[i]); i++; }
    }
    return out;
  }

  // Fills `container` with numbered lines of highlighted code.
  function renderCode(container, text, language, { lineNumbers = true } = {}) {
    const d = root.document;
    const tokens = tokenize(text.replace(/\r\n/g, '\n'), language);
    let line = d.createElement('span'); line.className = 'line';
    const lines = [line];
    for (const { cls, text: t } of tokens) {
      const parts = t.split('\n');
      parts.forEach((part, index) => {
        if (index) { line = d.createElement('span'); line.className = 'line'; lines.push(line); }
        if (!part) return;
        if (cls) { const span = d.createElement('span'); span.className = 'tok-' + cls; span.textContent = part; line.append(span); }
        else line.append(d.createTextNode(part));
      });
    }
    if (lines.length > 1 && !lines.at(-1).childNodes.length) lines.pop(); // trailing newline
    container.classList.toggle('numbered', lineNumbers);
    container.replaceChildren(...lines);
  }
  root.Highlighter = { tokenize, renderCode, resolve, languageFor, languages: Object.keys(languages) };
  if (typeof module !== 'undefined') module.exports = root.Highlighter;
})(globalThis);
