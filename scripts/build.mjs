import { mkdir, rm, cp, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';

const root = process.cwd(), output = resolve(root, 'dist');
if (dirname(output) !== resolve(root) || basename(output) !== 'dist') throw new Error('Unsafe build output path');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of ['index.html', 'favicon.svg', 'src']) await cp(resolve(root, entry), resolve(output, entry), { recursive: true });
// Version the whole module graph together so Pages/CDN caches cannot mix builds.
const inputs = ['index.html', 'src/app.js', 'src/core.js', 'src/examples.js', 'src/style.css'];
const hash = createHash('sha256');
for (const input of inputs) hash.update(await readFile(resolve(root, input)));
const version = hash.digest('hex').slice(0, 12);
for (const file of ['src/app.js', 'src/core.js', 'src/examples.js']) {
  const content = await readFile(resolve(output, file), 'utf8');
  await writeFile(resolve(output, file), content.replace(/(['"])(\.\/(?:core|examples)\.js)\1/g, (_, quote, path) => `${quote}${path}?v=${version}${quote}`));
}
const html = await readFile(resolve(output, 'index.html'), 'utf8');
await writeFile(resolve(output, 'index.html'), html.replace('./src/app.js', `./src/app.js?v=${version}`).replace('./src/style.css', `./src/style.css?v=${version}`));
await writeFile(resolve(output, '.nojekyll'), '');
process.stdout.write(`Built static site → dist/ (version ${version}, no external runtime dependencies)\n`);
