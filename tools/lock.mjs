// Builds a password-locked copy of Steward into dist/index.html.
// The app (with its scripts inlined) is encrypted with AES-256-GCM using a key derived from the password
// (PBKDF2-SHA256). The published page holds only ciphertext; the password is never written anywhere.
//   STEWARD_PASSWORD='your password' node tools/lock.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const password = process.env.STEWARD_PASSWORD;
if (!password || password.length < 8) {
  console.error('Set STEWARD_PASSWORD (at least 8 characters). Refusing to publish an unlocked site.');
  process.exit(1);
}
const ITER = 600000;

let app = readFileSync('index.html', 'utf8');
for (const file of ['kin-engine.js', 'assistant.js', 'sync.js']) {
  const tag = `<script src="${file}"></script>`;
  if (!app.includes(tag)) throw new Error('index.html is missing ' + tag);
  app = app.replace(tag, () => '<script>' + readFileSync(file, 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>');
}

// Inline the CDN libraries too: Chrome may block parser-blocking cross-site scripts added via document.write.
// VENDOR_DIR lets offline builds supply the files locally (matched by file name).
for (const [tag, url] of [...app.matchAll(/<script src="(https:[^"]+)"><\/script>/g)]) {
  const name = url.split('/').pop();
  const code = process.env.VENDOR_DIR ? readFileSync(process.env.VENDOR_DIR + '/' + name, 'utf8')
    : await fetch(url).then((r) => { if (!r.ok) throw new Error(url + ' returned ' + r.status); return r.text(); });
  app = app.replace(tag, () => '<script>' + code.replace(/<\/script/gi, '<\\/script') + '</script>');
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(app)));
const b64 = (u) => Buffer.from(u).toString('base64');

const gate = readFileSync('tools/gate.html', 'utf8')
  .replace('__PAYLOAD__', () => JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), data: b64(data) }));
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', gate);
copyFileSync('.nojekyll', 'dist/.nojekyll');
console.log('Locked build written to dist/index.html (' + Math.round(gate.length / 1024) + ' KB)');
