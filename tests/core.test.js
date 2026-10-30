import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble, Pipeline, decode, readWord, writeWord, i64, OP, MEMORY_SIZE, AssemblyError, FORWARD_PATHS } from '../src/core.js';
import { EXAMPLES } from '../src/examples.js';

// Independent instruction-at-a-time oracle: no pipeline/forwarding/ALU helpers.
function reference(program, limit = 10000) {
  const memory = program.memory.slice(), regs = Array(15).fill(0n);
  let pc = 0n, cc = { ZF: true, SF: false, OF: false }, status = 'AOK', count = 0;
  function cond(f) {
    const l = cc.SF !== cc.OF;
    return [true, l || cc.ZF, l, cc.ZF, !cc.ZF, !l, !l && !cc.ZF][f];
  }
  while (count++ < limit && status === 'AOK') {
    const s = decode(memory, pc), a = regs[s.rA] ?? 0n, b = regs[s.rB] ?? 0n;
    if (s.stat !== 'AOK') { status = s.stat; break; }
    pc = s.valP;
    try {
      switch (s.icode) {
        case OP.NOP: break;
        case OP.MOV: if (cond(s.ifun)) regs[s.rB] = a; break;
        case OP.IMM: regs[s.rB] = s.valC; break;
        case OP.STORE: writeWord(memory, i64(b + s.valC), a); break;
        case OP.LOAD: regs[s.rA] = readWord(memory, i64(b + s.valC)); break;
        case OP.ALU: case OP.IADD: {
          const x = s.icode === OP.IADD ? s.valC : a, fn = s.icode === OP.IADD ? 0 : s.ifun;
          const math = fn === 0 ? b + x : fn === 1 ? b - x : fn === 2 ? b & x : b ^ x, result = i64(math);
          cc = { ZF: result === 0n, SF: result < 0n, OF: fn <= 1 && (math < -(1n << 63n) || math > (1n << 63n) - 1n) };
          regs[s.rB] = result; break;
        }
        case OP.JUMP: if (cond(s.ifun)) pc = s.valC; break;
        case OP.CALL: { const next = i64(regs[4] - 8n); writeWord(memory, next, s.valP); regs[4] = next; pc = s.valC; break; }
        case OP.RET: { const target = readWord(memory, regs[4]); regs[4] = i64(regs[4] + 8n); pc = target; break; }
        case OP.PUSH: { const next = i64(regs[4] - 8n); writeWord(memory, next, a); regs[4] = next; break; }
        case OP.POP: { const value = readWord(memory, regs[4]); regs[4] = i64(regs[4] + 8n); regs[s.rA] = value; break; }
        default: status = 'INS';
      }
    } catch { status = 'ADR'; }
  }
  return { regs, cc, memory, status };
}

function compare(source, options) {
  const program = assemble(source), pipe = new Pipeline(program, options).run(), expected = reference(program);
  assert.equal(pipe.status, expected.status, 'terminal status');
  assert.deepEqual(pipe.regs, expected.regs, 'register values');
  assert.deepEqual(pipe.cc, expected.cc, 'condition codes');
  assert.deepEqual(pipe.memory, expected.memory, 'memory side effects');
  return pipe;
}

for (const example of EXAMPLES) test(`example ${example.id}: pipeline matches sequential execution`, () => compare(example.source));
test('example answers are meaningful', () => {
  const states = EXAMPLES.map(e => new Pipeline(assemble(e.source)).run());
  assert.equal(states[0].regs[3], 22n); assert.equal(states[0].regs[1], 12n);
  assert.equal(states[1].regs[3], 42n); assert.equal(states[2].regs[3], 7n);
  assert.equal(states[3].regs[0], 42n); assert.equal(states[3].regs[4], 512n);
  assert.equal(states[4].regs[0], 100n); assert.equal(states[5].regs[2], 42n); assert.equal(states[5].regs[1], 0n);
});
test('load/use stalls exactly once; ALU dependencies use forwarding', () => {
  const p = compare(EXAMPLES[1].source);
  assert.equal(p.trace.filter(t => t.loadUse).length, 1);
  const f = compare(EXAMPLES[0].source);
  assert.equal(f.stalls, 0); assert(f.events.some(e => e.type === 'forward'));
});
test('misprediction flushes speculative writes and flags', () => {
  const p = compare(`irmovq $1, %rax\nxorq %rax, %rax\njne wrong\nirmovq $7, %rbx\nhalt\nwrong: irmovq $99, %rbx\nsubq %rcx, %rcx\nhalt`);
  assert.equal(p.flushes, 1); assert.equal(p.regs[3], 7n);
});
test('same register destination in popq %rsp: memory result takes priority', () => {
  const p = compare(`irmovq $0x200, %rsp\nirmovq $0x300, %rax\npushq %rax\npopq %rsp\nrrmovq %rsp, %rbx\nhalt`);
  assert.equal(p.regs[4], 768n); assert.equal(p.regs[3], 768n);
});
test('load/use uses decoded sources, including stack pointer', () => {
  const p = compare(`irmovq $0x200, %rsp\nirmovq $9, %rax\npushq %rax\npopq %rbx\naddq %rbx, %rax\nhalt`);
  assert.equal(p.regs[0], 18n); assert.equal(p.trace.filter(t => t.loadUse).length, 1);
});
test('arithmetic wraps as signed 64-bit with correct overflow flags', () => {
  const p = compare(`irmovq $0x7fffffffffffffff, %rax\niaddq $1, %rax\nhalt`);
  assert.equal(p.regs[0], -(1n << 63n)); assert(p.cc.OF);
  compare(`irmovq $0x8000000000000000, %rax\nirmovq $1, %rbx\nsubq %rbx, %rax\nhalt`);
});
test('halt suppresses all younger register, memory and CC writes', () => {
  const p = compare(`irmovq $0x200, %rdi\nirmovq $15, %rax\nhalt\nrmmovq %rax, 0(%rdi)\nsubq %rax, %rax\nirmovq $1, %rbx`);
  assert.equal(readWord(p.memory, 512n), 0n); assert.equal(p.regs[0], 15n);
});
test('address and instruction exceptions suppress younger side effects', () => {
  const p = compare(`irmovq $0xffff, %rdi\nmrmovq 0(%rdi), %rax\nirmovq $123, %rbx\nxorq %rcx, %rcx\nhalt`);
  assert.equal(p.status, 'ADR'); assert.equal(p.regs[3], 0n);
  compare(`.byte 0xff\nirmovq $123, %rax\nhalt`);
  compare(`irmovq $-1, %rdi\nrmmovq %rax, 0(%rdi)\nhalt`);
});
test('all conditional moves and branches compare correctly', () => {
  for (const n of [-7, 0, 7]) for (const c of ['le', 'l', 'e', 'ne', 'ge', 'g']) {
    compare(`irmovq $${n}, %rax\nirmovq $42, %rcx\nandq %rax, %rax\ncmov${c} %rcx, %rbx\nj${c} yes\nirmovq $9, %rdx\nhalt\nyes: irmovq $11, %rdx\nhalt`);
  }
});
test('nested calls and recursive stack frames return correctly', () => compare(`irmovq $0x800, %rsp\nirmovq $5, %rdi\ncall sum\nhalt\nsum: andq %rdi, %rdi\nje base\npushq %rdi\niaddq $-1, %rdi\ncall sum\npopq %rbx\naddq %rbx, %rax\nret\nbase: xorq %rax, %rax\nret`));
test('snapshot and restore replay the exact next edge', () => {
  const p = new Pipeline(assemble(EXAMPLES[4].source));
  for (let i = 0; i < 12; i++) p.step();
  const checkpoint = p.snapshot(); p.step(); const next = p.snapshot();
  p.restore(checkpoint); p.step(); assert.deepEqual(p.snapshot(), next);
});
test('assembler emits standard bytes and supports forward labels/data directives', () => {
  const p = assemble('irmovq $10, %rax\nrrmovq %rax, %rdx\nhalt\n.align 8\ndata: .quad -1, 0x1122334455667788\n.long 0x12345678\n.byte 0xaa\n.zero 3');
  assert.deepEqual([...p.memory.slice(0, 13)], [0x30, 0xf0, 10, 0, 0, 0, 0, 0, 0, 0, 0x20, 0x02, 0]);
  assert.equal(readWord(p.memory, 16n), -1n); assert.equal(readWord(p.memory, 24n), 0x1122334455667788n);
});
test('yo import executes bytes rather than trusting assembly comments', () => {
  const p = compare('0x000: 30f00a00000000000000 | irmovq $99, %rax\n0x00a: 2002 | rrmovq %rax, %rdx\n0x00c: 00 | halt');
  assert.equal(p.regs[0], 10n); assert.equal(p.regs[2], 10n);
});
test('assembler reports actionable errors and rejects overlaps/overflow', () => {
  for (const text of ['rrmovq %rax, %wat', 'movq %rax, %rdx', 'addq %rax', 'irmovq missing, %rax', '.pos -1\nhalt', '.byte 256', '.pos 0xffff\n.quad 1', 'halt\n.pos 0\nnop', 'x: halt\nx: nop', '0x000: 3 | broken']) assert.throws(() => assemble(text), AssemblyError, text);
  assert.equal(assemble('.zero 65536').memory.length, MEMORY_SIZE);
});
test('deterministic randomized dependencies match an independent ISA model', () => {
  let seed = 73021;
  const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const regs = ['%rax', '%rcx', '%rdx', '%rbx', '%r8', '%r9', '%r10', '%r11'];
  for (let trial = 0; trial < 150; trial++) {
    const lines = ['irmovq $0x800, %rsp', 'irmovq $0x1000, %rdi'];
    for (let j = 0; j < 50; j++) {
      const a = regs[rnd(regs.length)], b = regs[rnd(regs.length)], offset = rnd(8) * 8;
      switch (rnd(10)) {
        case 0: lines.push(`irmovq $${rnd(2000) - 1000}, ${b}`); break;
        case 1: lines.push(`rrmovq ${a}, ${b}`); break;
        case 2: case 3: lines.push(`${['addq', 'subq', 'andq', 'xorq'][rnd(4)]} ${a}, ${b}`); break;
        case 4: lines.push(`rmmovq ${a}, ${offset}(%rdi)`); break;
        case 5: lines.push(`mrmovq ${offset}(%rdi), ${b}`); break;
        case 6: lines.push(`pushq ${a}`, `popq ${b}`); break;
        case 7: lines.push(`cmov${['le', 'l', 'e', 'ne', 'ge', 'g'][rnd(6)]} ${a}, ${b}`); break;
        case 8: lines.push(`iaddq $${rnd(30) - 15}, ${b}`); break;
        default: lines.push('nop');
      }
    }
    lines.push('halt'); compare(lines.join('\n'));
    compare(lines.join('\n'), { forwarding: Object.fromEntries(FORWARD_PATHS.map((id, i) => [id, Boolean((trial % 32) & (1 << i))])) });
  }
});


test('all 32 forwarding configurations preserve the ISA results of all 19 examples', () => {
  for (let mask = 0; mask < 32; mask++) {
    const forwarding = Object.fromEntries(FORWARD_PATHS.map((id, i) => [id, Boolean(mask & (1 << i))]));
    for (const example of EXAMPLES) compare(example.source, { forwarding });
  }
});

test('disabled forwarding waits for the youngest writer and never takes an older value', () => {
  const source = 'irmovq $1, %rax\nirmovq $2, %rax\nrrmovq %rax, %rbx\nhalt';
  const pipe = compare(source, { forwarding: { E_valE: false, M_valE: false } });
  assert.equal(pipe.regs[3], 2n);
  assert.equal(pipe.stalls, 2);
  assert(pipe.events.some(event => event.message.includes('E_valE')));
  const allOff = compare(source, { forwarding: Object.fromEntries(FORWARD_PATHS.map(id => [id, false])) });
  assert.equal(allOff.stalls, 3); // E, M, W; register file is read before the writeback edge.
});

test('misprediction flush beats a disabled-path dependency in the wrong-path D instruction', () => {
  const program = assemble('irmovq $9, %rbx\nxorq %rax, %rax\njne wrong\nirmovq $1, %rax\nhalt\nwrong: rrmovq %rbx, %rdx\nhalt');
  const pipe = new Pipeline(program, { forwarding: { W_valE: false } });
  let observed = false;
  while (pipe.status === 'AOK') {
    const signals = pipe.evaluate();
    if (signals.mispredict && signals.blocked.length) { observed = true; assert(!signals.D_stall); assert(signals.D_bubble); }
    pipe.step();
  }
  assert(observed); assert.equal(pipe.regs[2], 0n); assert.equal(pipe.regs[0], 1n);
});

test('snapshots retain forwarding settings and replay extra dependency stalls', () => {
  const pipe = new Pipeline(assemble(EXAMPLES[0].source), { forwarding: { E_valE: false, W_valE: false } });
  for (let i = 0; i < 3; i++) pipe.step();
  const saved = pipe.snapshot(); pipe.step(); const expected = pipe.snapshot();
  pipe.forwarding.M_valE = false; pipe.restore(saved); pipe.step();
  assert.deepEqual(pipe.snapshot(), expected);
});
