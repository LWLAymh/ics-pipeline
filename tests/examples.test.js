import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../src/examples.js';
import { Pipeline, assemble, readWord } from '../src/core.js';

const answers = [
  { id: 'slides-adjacent', regs: { 0: 13n, 2: 10n }, loads: 0 },
  { id: 'slides-gap', regs: { 0: 13n, 2: 10n }, loads: 0 },
  { id: 'slides-two-nops', regs: { 0: 13n, 2: 10n }, loads: 0 },
  { id: 'slides-push-rsp', regs: { 0: 0x200n, 4: 0x200n }, memory: [[0x1f8n, 0x200n]] },
  { id: 'slides-pop-rsp', regs: { 3: 0x300n, 4: 0x300n }, loads: 1 },
  { id: 'slides-encoding-call', regs: { 3: 10n, 4: 0x7f8n }, memory: [[0x7f0n, 0x20bn]] },
  { id: 'slides-negative-offset', regs: { 0: 0x1122334455667788n }, memory: [[0x100n, 0x1122334455667788n]] },
  { id: 'slides-combination-a', regs: { 0: 1n, 4: 0x200n }, combination: 'A' },
  { id: 'slides-combination-b', regs: { 0: 42n, 4: 0x208n }, loads: 1, combination: 'B' },
  { id: 'slides-load-nop', regs: { 0: 13n }, loads: 0 },
  { id: 'slides-repeated-load', regs: { 0: 5n, 3: 12n }, loads: 3 },
  { id: 'slides-cmov-forward', regs: { 2: 5n, 3: 9n, 6: 9n }, loads: 0 },
];

for (const answer of answers) test(`slides example ${answer.id}: expected result and teaching behavior`, () => {
  const example = EXAMPLES.find(entry => entry.id === answer.id);
  assert(example, 'Example must appear in the selector');
  const pipeline = new Pipeline(assemble(example.source)).run(500);
  assert.equal(pipeline.status, 'HLT', 'Example must finish without address or instruction errors');
  for (const [index, value] of Object.entries(answer.regs)) assert.equal(pipeline.regs[Number(index)], value);
  for (const [address, value] of answer.memory || []) assert.equal(readWord(pipeline.memory, address), value);
  if (answer.loads !== undefined) assert.equal(pipeline.trace.filter(frame => frame.loadUse).length, answer.loads);
  if (answer.combination === 'A') assert(pipeline.trace.some(frame => frame.mispredict && frame.ret));
  if (answer.combination === 'B') assert(pipeline.trace.some(frame => frame.loadUse && frame.ret && frame.D_stall && !frame.D_bubble));
});

test('example identifiers, numbered names and programs stay unique', () => {
  assert.equal(new Set(EXAMPLES.map(example => example.id)).size, EXAMPLES.length);
  assert.equal(new Set(EXAMPLES.map(example => example.name)).size, EXAMPLES.length);
  assert.equal(new Set(EXAMPLES.map(example => example.source)).size, EXAMPLES.length);
});
