// Builds the distributable bookmarklet and the GitHub Pages install page.
//   node build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { minify } from 'terser';

const SRC = 'src/fb-comment-explorer.js';

const source = readFileSync(SRC, 'utf8');

const { code, error } = await minify(source, {
  compress: true,
  mangle: true,
  format: { quote_style: 1, comments: /^!/ }
});
if (error) throw error;

const min = code.trim();

// javascript: URLs are percent-decoded before they run, so encoding the whole
// payload is the safe way to survive quotes, newlines and non-ASCII regexes.
// encodeURIComponent leaves ' alone and the minified code is full of single-quoted
// strings, so escape those too - otherwise the payload is only safe inside a
// double-quoted attribute, and breaks wherever someone pastes it into a single-quoted one.
const bookmarklet = 'javascript:' + encodeURIComponent(min).replace(/'/g, '%27');
if (decodeURIComponent(bookmarklet.slice('javascript:'.length)) !== min) {
  throw new Error('bookmarklet does not round-trip');
}

mkdirSync('dist', { recursive: true });
writeFileSync('dist/fb-comment-explorer.min.js', min + '\n');
writeFileSync('dist/bookmarklet.txt', bookmarklet);
mkdirSync('docs', { recursive: true });
// Also published, so anyone who prefers pasting a bookmark by hand can fetch it.
writeFileSync('docs/bookmarklet.txt', bookmarklet);

const page = readFileSync('src/index.template.html', 'utf8')
  .replace('__SCREENSHOT__', () => readFileSync('src/screenshot.html', 'utf8').trim())
  .replace('__BOOKMARKLET__', () => bookmarklet);

if (page.includes('__BOOKMARKLET__') || page.includes('__SCREENSHOT__')) {
  throw new Error('template placeholder was not replaced');
}
// The encoded payload must not contain characters that would end the href attribute.
if (/["'<>]/.test(bookmarklet)) throw new Error('bookmarklet is not attribute-safe');

writeFileSync('docs/index.html', page);

console.log('source      %d bytes', source.length);
console.log('minified    %d bytes', min.length);
console.log('bookmarklet %d chars', bookmarklet.length);
console.log('page        %d bytes', page.length);
