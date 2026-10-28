import { mkdir, rm, cp, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';

const root = process.cwd(), output = resolve(root, 'dist');
if (dirname(output) !== resolve(root) || basename(output) !== 'dist') throw new Error('Unsafe build output path');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of ['index.html', 'favicon.svg', 'src']) await cp(resolve(root, entry), resolve(output, entry), { recursive: true });
await writeFile(resolve(output, '.nojekyll'), '');
process.stdout.write('Built static site → dist/ (no external runtime dependencies)\n');
