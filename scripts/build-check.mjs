import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const htmlFiles = ['admin.html', 'index.html', 'judge.html', 'login.html', 'publish.html', 'register.html', 'results.html', 'team.html', 'tv.html'];
const externalScriptPages = ['admin.html', 'judge.html', 'login.html'];
const jsFiles = ['dependency-loader.js', 'branding-config.js', 'image-upload.js', 'fest-config.js', 'poster-certificate-engine.js', 'poster-certificate-admin.js', 'admin-utils.js', 'admin-dashboard.js', 'admin-students.js', 'admin-events.js', 'admin-auth.js', 'admin-main.js', 'judge.js', 'score-utils.js', 'login.js'];
const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function assertBalancedHtml(file, html) {
  const stack = [];
  const source = html.replace(/<!--[\s\S]*?-->/gu, '');
  for (const match of source.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/giu)) {
    const tag = match[1].toLowerCase();
    if (voidElements.has(tag) || match[0].endsWith('/>')) continue;
    if (!match[0].startsWith('</')) {
      stack.push(tag);
      continue;
    }
    const open = stack.pop();
    if (open !== tag) throw new Error(`${file} has unbalanced HTML: expected </${open || 'none'}> before </${tag}>`);
  }
  if (stack.length) throw new Error(`${file} has unclosed <${stack.at(-1)}> element`);
}

readFileSync('storage.rules', 'utf8');
for (const file of [...htmlFiles, ...jsFiles]) readFileSync(file, 'utf8');
for (const file of externalScriptPages) {
  const html = readFileSync(file, 'utf8');
  assertBalancedHtml(file, html);
  if (/<script(?![^>]*src)/u.test(html)) throw new Error(`${file} contains inline script tags`);
  if (/\son[a-z]+="/u.test(html)) throw new Error(`${file} contains inline event handlers`);
}
for (const file of htmlFiles.filter(file => !externalScriptPages.includes(file))) {
  const html = readFileSync(file, 'utf8');
  for (const match of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/gu)) execFileSync(process.execPath, ['--input-type=module', '--check'], { input: match[1], stdio: ['pipe', 'pipe', 'pipe'] });
}
console.log('Static build/load check passed');
