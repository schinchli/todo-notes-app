import { writeClientCode } from '@aws-blocks/blocks/scripts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

await writeClientCode(
  join(root, 'aws-blocks', 'index.ts'),
  join(root, 'aws-blocks', 'client.js'),
);

console.log('Generated aws-blocks/client.js');
