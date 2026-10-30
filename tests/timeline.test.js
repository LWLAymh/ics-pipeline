import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble, Pipeline } from '../src/core.js';
import { EXAMPLES } from '../src/examples.js';
import { buildTimeline, layoutTimelineRows, timelineGeometry } from '../src/timeline.js';

const lecture = () => new Pipeline(assemble(EXAMPLES.find(example => example.id === 'lecture').source));
const advance = (simulator, count) => { for (let i = 0; i < count; i++) simulator.step(); return buildTimeline(simulator.program, simulator); };
const currentCells = model => model.rows.flatMap(row => row.cells.filter(cell => cell.cycle === model.cycle).map(cell => ({ label: row.label, bubble: row.bubble, canceled: row.canceled, ...cell })));

test('responsive timeline leaves at least one full cycle beside fixed labels', () => {
  for (const viewport of [248, 288, 360, 800, 1200, 1600]) for (const scale of [.8, 1, 1.2]) {
    const geometry = timelineGeometry(viewport, scale);
    assert(geometry.gridX + geometry.columnWidth <= viewport);
    assert(geometry.labelLimit > 10);
    assert(geometry.gridX <= 375);
  }
});

test('initial frame shows the first fetch, pending source rows and no future cells', () => {
  const p = lecture(), model = buildTimeline(p.program, p);
  assert.equal(model.cycle, 1); assert.equal(model.rows.length, 7);
  assert.deepEqual(currentCells(model).map(cell => cell.stage), ['F']);
  assert(model.rows.every(row => row.cells.every(cell => cell.cycle <= model.cycle)));
  assert.equal(model.rows[0].label, '0x000: irmovq $128, %rdx');
});
test('cycle 6 reproduces the lecture screenshot, including memory store in M', () => {
  const p = lecture(), model = advance(p, 5), cells = currentCells(model);
  assert.equal(model.cycle, 6);
  assert.deepEqual(cells.map(cell => cell.stage), ['W', 'M', 'E', 'D', 'F']);
  assert(cells.find(cell => cell.stage === 'M').label.includes('rmmovq'));
  assert(cells.find(cell => cell.stage === 'D').label.includes('mrmovq'));
  assert.equal(p.evaluate().memoryAddress, 128n); assert(p.evaluate().memoryWrite);
});
test('load/use injects one moving E bubble and repeats held F and D cells', () => {
  const p = lecture();
  const before = advance(p, 6);
  assert.equal(before.cycle, 7); assert.equal(before.rows.filter(row => row.bubble).length, 0);
  const after = advance(p, 1), cells = currentCells(after);
  assert.equal(after.cycle, 8);
  assert.equal(cells.find(cell => cell.bubble).stage, 'E');
  assert.deepEqual(cells.filter(cell => cell.stalled).map(cell => cell.stage), ['D', 'F']);
  assert.equal(after.forwards.length, 2);
  assert(after.rows.findIndex(row => row.bubble) < after.rows.findIndex(row => row.label.includes('addq')));
  const bubble = after.rows.find(row => row.bubble), id = bubble.id;
  const next = advance(p, 1);
  assert.equal(next.rows.find(row => row.id === id).cells.at(-1).stage, 'M');
});
test('back and replay do not leave future cells or bubble tracks behind', () => {
  const p = lecture(); advance(p, 5); const checkpoint = p.snapshot();
  advance(p, 3); p.restore(checkpoint);
  const model = buildTimeline(p.program, p);
  assert.equal(model.cycle, 6); assert.equal(model.rows.filter(row => row.bubble).length, 0);
  assert(model.rows.every(row => row.cells.every(cell => cell.cycle <= 6)));
});

test('stall opens a lane locally without moving the earlier F/D blocks down', () => {
  const p = lecture(), before = advance(p, 6);
  const oldRows = layoutTimelineRows(before.rows, before.cycle);
  const oldAdd = oldRows.find(row => row.label.includes('addq'));
  const after = advance(p, 1), rows = layoutTimelineRows(after.rows, after.cycle);
  const add = rows.find(row => row.label.includes('addq'));
  assert.deepEqual(add.cells.filter(cell => cell.cycle < 8).map(cell => cell.lane), oldAdd.cells.map(cell => cell.lane));
  assert.equal(add.cells.find(cell => cell.cycle === 7).lane, 5);
  assert.equal(add.cells.find(cell => cell.cycle === 8).lane, 6);
  assert.equal(add.turns.length, 1); assert.equal(add.turns[0].cell.cycle, 8);
  const halt = rows.find(row => row.label.includes('halt'));
  assert.equal(halt.cells.find(cell => cell.cycle === 7).lane, 6);
  assert.equal(halt.cells.find(cell => cell.cycle === 8).lane, 7);
  const later = advance(p, 2), finalAdd = layoutTimelineRows(later.rows, later.cycle).find(row => row.id === add.id);
  assert.deepEqual(finalAdd.cells.slice(0, add.cells.length).map(cell => cell.lane), add.cells.map(cell => cell.lane));
});

test('separate stalls create separate turns and rewind removes only the later one', () => {
  const p = new Pipeline(assemble('irmovq $0x100, %rdi\nmrmovq 0(%rdi), %rax\naddq %rax, %rbx\nmrmovq 8(%rdi), %rcx\naddq %rcx, %rbx\nhalt\n.pos 0x100\n.quad 3, 4'));
  advance(p, 4); const saved = p.snapshot();
  p.run(); const model = buildTimeline(p.program, p), rows = layoutTimelineRows(model.rows, model.cycle);
  const adds = rows.filter(row => row.label.includes('addq'));
  assert.equal(adds.length, 2); assert(adds.every(row => row.turns.length === 1));
  assert(adds[0].turns[0].cell.cycle < adds[1].turns[0].cell.cycle);
  p.restore(saved); const restored = buildTimeline(p.program, p);
  assert.equal(layoutTimelineRows(restored.rows, restored.cycle).flatMap(row => row.turns).filter(turn => turn.cell.stage === 'D').length, 1);
});
test('wrong-path instructions are crossed out only after the flush edge', () => {
  const p = new Pipeline(assemble('xorq %rax, %rax\njne wrong\nirmovq $1, %rax\nhalt\nwrong: irmovq $2, %rdx\nirmovq $3, %rbx\nhalt'));
  const detected = advance(p, 3); assert.equal(detected.cycle, 4);
  assert.equal(detected.rows.filter(row => row.canceled).length, 0);
  const flushed = advance(p, 1);
  assert.equal(flushed.rows.filter(row => row.canceled).length, 2);
  assert.deepEqual(currentCells(flushed).filter(cell => cell.bubble).map(cell => cell.stage).sort(), ['D', 'E']);
});
test('ret pause creates D/E/M/W bubble paths instead of fake fetch instructions', () => {
  const p = new Pipeline(assemble(EXAMPLES.find(example => example.id === 'stack').source));
  let model;
  while (p.status === 'AOK' && p.cycle < 50) {
    model = buildTimeline(p.program, p);
    if (p.evaluate().ret) assert(!currentCells(model).some(cell => cell.stage === 'F'));
    p.step();
  }
  assert(model.rows.some(row => row.bubble && row.cells.some(cell => cell.stage === '停')));
});
test('loop iterations have distinct rows and history is bounded', () => {
  const p = new Pipeline(assemble('irmovq $3, %rax\nloop: iaddq $-1, %rax\njne loop\nhalt')).run();
  const model = buildTimeline(p.program, p);
  const iterations = model.rows.filter(row => row.label.includes('iaddq'));
  assert.equal(iterations.length, 4); // Three real iterations plus the final wrong-path fetch.
  assert.equal(iterations.filter(row => !row.canceled).length, 3);
  assert.equal(new Set(iterations.map(row => row.id)).size, 4);
  const long = new Pipeline(assemble('loop: jmp loop'));
  advance(long, 650);
  const window = buildTimeline(long.program, long);
  assert.equal(window.firstCycle, 612); assert.equal(window.endCycle, 653);
  assert(window.rows.length <= 120);
});
test('terminal frame includes halt at W, with no invented trailing zero-byte halts', () => {
  const p = lecture().run(), model = buildTimeline(p.program, p);
  assert.equal(p.regs[0], 13n); assert(model.terminal);
  assert.equal(model.rows.filter(row => row.label.includes('halt')).length, 1);
  assert(currentCells(model).some(cell => cell.stage === 'W' && cell.label.includes('halt')));
});
