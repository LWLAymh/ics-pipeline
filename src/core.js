// Y86-64 assembler and synchronous, five-stage PIPE model.
// Values on wires are BigInts. Pipeline registers change together on a clock edge.
export const REGISTERS = ['%rax', '%rcx', '%rdx', '%rbx', '%rsp', '%rbp', '%rsi', '%rdi', '%r8', '%r9', '%r10', '%r11', '%r12', '%r13', '%r14'];
export const NONE = 15;
export const RSP = 4;
export const MEMORY_SIZE = 65536;
export const OP = Object.freeze({ HALT: 0, NOP: 1, MOV: 2, IMM: 3, STORE: 4, LOAD: 5, ALU: 6, JUMP: 7, CALL: 8, RET: 9, PUSH: 10, POP: 11, IADD: 12 });
const CONDITIONS = ['', 'le', 'l', 'e', 'ne', 'ge', 'g'];
const ALUS = ['addq', 'subq', 'andq', 'xorq'];
const TERMINAL = new Set(['HLT', 'ADR', 'INS']);
export const i64 = value => BigInt.asIntN(64, BigInt(value));
export const hex = (value, width = 0) => '0x' + BigInt.asUintN(64, BigInt(value)).toString(16).padStart(width, '0');
export const regName = value => REGISTERS[value] ?? '—';
export const isTerminal = stat => TERMINAL.has(stat);

export class AssemblyError extends Error {
  constructor(line, message) { super(`第 ${line} 行：${message}`); this.line = line; this.name = 'AssemblyError'; }
}

const instruction = name => {
  const fixed = { halt: [0, 0, 1], nop: [1, 0, 1], rrmovq: [2, 0, 2], irmovq: [3, 0, 10], rmmovq: [4, 0, 10], mrmovq: [5, 0, 10], call: [8, 0, 9], ret: [9, 0, 1], pushq: [10, 0, 2], popq: [11, 0, 2], iaddq: [12, 0, 10] };
  if (fixed[name]) return fixed[name];
  if (ALUS.includes(name)) return [6, ALUS.indexOf(name), 2];
  if (name === 'jmp') return [7, 0, 9];
  const cmov = CONDITIONS.findIndex((c, i) => i > 0 && name === 'cmov' + c);
  if (cmov > 0) return [2, cmov, 2];
  const jump = CONDITIONS.findIndex((c, i) => i > 0 && name === 'j' + c);
  return jump > 0 ? [7, jump, 9] : null;
};

function expression(text, labels, line) {
  text = text.trim().replace(/^\$/, '');
  const literal = /^[+-]?(?:0x[\da-f]+|\d+)$/i;
  if (literal.test(text)) {
    const negative = text.startsWith('-');
    return (negative ? -1n : 1n) * BigInt(text.replace(/^[+-]/, ''));
  }
  const match = /^([A-Za-z_.$][\w.$]*)(?:\s*([+-])\s*(0x[\da-f]+|\d+))?$/i.exec(text);
  if (!match || !labels.has(match[1])) throw new AssemblyError(line, `无法识别数值或标签 “${text}”`);
  return BigInt(labels.get(match[1])) + (match[2] === '-' ? -1n : 1n) * BigInt(match[3] || 0);
}

function address(value, line) {
  if (value < 0n || value >= BigInt(MEMORY_SIZE)) throw new AssemblyError(line, '地址须在 0x0000～0xffff 范围内');
  return Number(value);
}

function parseRegister(text, line) {
  const reg = REGISTERS.indexOf(text.trim().toLowerCase());
  if (reg < 0) throw new AssemblyError(line, `未知寄存器 “${text}”；使用 %rax～%r14`);
  return reg;
}

function memoryOperand(text, labels, line) {
  const match = /^(.*?)\(\s*(%\w+)\s*\)$/.exec(text.trim());
  if (!match) throw new AssemblyError(line, '内存操作数格式为 D(%寄存器)，例如 8(%rsp)');
  return [parseRegister(match[2], line), expression(match[1].trim() || '0', labels, line)];
}

function numberBytes(value, size) {
  const bits = BigInt(size * 8);
  if (value < -(1n << (bits - 1n)) || value >= (1n << bits)) throw new Error(`数值超出 ${size * 8} 位范围`);
  let unsigned = BigInt.asUintN(Number(bits), value);
  return Array.from({ length: size }, () => { const b = Number(unsigned & 255n); unsigned >>= 8n; return b; });
}

/** Assemble .ys or load the hexadecimal address/byte format emitted by yas (.yo). */
export function assemble(source) {
  if (source.split(/\r?\n/).some(line => /^\s*0x[\da-f]+\s*:/i.test(line))) return loadObject(source);
  const labels = new Map(), records = [], memory = new Uint8Array(MEMORY_SIZE), listing = new Map(), used = new Set();
  let pc = 0;
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    let text = lines[index].replace(/[#;].*$/, '').trim();
    while (/^[A-Za-z_.$][\w.$]*\s*:/.test(text)) {
      const end = text.indexOf(':'), label = text.slice(0, end).trim();
      if (labels.has(label)) throw new AssemblyError(line, `标签 “${label}” 重复定义`);
      labels.set(label, pc); text = text.slice(end + 1).trim();
    }
    if (!text) continue;
    const [, rawName, args = ''] = /^(\S+)(?:\s+(.*))?$/.exec(text), name = rawName.toLowerCase();
    if (name === '.pos') { pc = address(expression(args, labels, line), line); continue; }
    if (name === '.align') {
      const alignment = expression(args, labels, line);
      if (alignment < 1n || alignment > BigInt(MEMORY_SIZE)) throw new AssemblyError(line, '.align 需要正的对齐字节数');
      pc = Math.ceil(pc / Number(alignment)) * Number(alignment); continue;
    }
    let size, spec;
    if (['.quad', '.long', '.byte'].includes(name)) {
      const unit = { '.quad': 8, '.long': 4, '.byte': 1 }[name];
      size = unit * args.split(',').length;
    } else if (name === '.zero') {
      const count = expression(args, labels, line);
      if (count < 0n || count > BigInt(MEMORY_SIZE)) throw new AssemblyError(line, '.zero 的长度超出内存范围');
      size = Number(count);
    } else {
      spec = instruction(name);
      if (!spec) throw new AssemblyError(line, `未知 Y86-64 指令 “${name}”`);
      size = spec[2];
    }
    if (pc + size > MEMORY_SIZE) throw new AssemblyError(line, '程序超出 64 KiB 内存');
    records.push({ pc, line, text, name, args, size, spec }); pc += size;
  }
  if (!records.length) throw new AssemblyError(1, '请输入 Y86-64 汇编，或载入一个示例');
  for (const record of records) {
    const { pc, line, text, name, args, spec } = record;
    let bytes = [];
    try {
      if (name === '.zero') bytes = Array(record.size).fill(0);
      else if (name.startsWith('.')) {
        const size = { '.quad': 8, '.long': 4, '.byte': 1 }[name];
        bytes = args.split(',').flatMap(arg => numberBytes(expression(arg, labels, line), size));
      } else {
        const [icode, ifun] = spec, parts = args ? args.split(',').map(s => s.trim()) : [];
        const expected = [0, 1, 9].includes(icode) ? 0 : [7, 8, 10, 11].includes(icode) ? 1 : 2;
        if (parts.length !== expected || parts.some(p => !p)) throw new AssemblyError(line, `${name} 需要 ${expected} 个操作数`);
        let rA = NONE, rB = NONE, valC = 0n;
        if ([2, 6].includes(icode)) { rA = parseRegister(parts[0], line); rB = parseRegister(parts[1], line); }
        if ([3, 12].includes(icode)) { valC = expression(parts[0], labels, line); rB = parseRegister(parts[1], line); }
        if (icode === 4) { rA = parseRegister(parts[0], line); [rB, valC] = memoryOperand(parts[1], labels, line); }
        if (icode === 5) { [rB, valC] = memoryOperand(parts[0], labels, line); rA = parseRegister(parts[1], line); }
        if ([7, 8].includes(icode)) valC = expression(parts[0], labels, line);
        if ([10, 11].includes(icode)) rA = parseRegister(parts[0], line);
        bytes = [icode * 16 + ifun];
        if ([2, 3, 4, 5, 6, 10, 11, 12].includes(icode)) bytes.push(rA * 16 + rB);
        if ([3, 4, 5, 7, 8, 12].includes(icode)) bytes.push(...numberBytes(valC, 8));
      }
      for (let i = 0; i < bytes.length; i++) {
        if (used.has(pc + i)) throw new AssemblyError(line, `地址 ${hex(pc + i)} 与前面的代码或数据重叠`);
        used.add(pc + i); memory[pc + i] = bytes[i];
      }
    } catch (error) { if (error instanceof AssemblyError) throw error; throw new AssemblyError(line, error.message); }
    listing.set(pc, { pc: BigInt(pc), line, text, bytes, isData: name.startsWith('.') });
  }
  return { memory, listing, labels, source, used };
}

function loadObject(source) {
  const memory = new Uint8Array(MEMORY_SIZE), listing = new Map(), used = new Set();
  let entries = 0;
  source.split(/\r?\n/).forEach((text, i) => {
    if (!text.trim() || !/^\s*0x/i.test(text)) return;
    const match = /^\s*0x([\da-f]+)\s*:\s*([\da-f]*)(?:\s*\|\s*(.*))?\s*$/i.exec(text);
    if (!match || match[2].length % 2) throw new AssemblyError(i + 1, '无效的 .yo 地址或字节编码');
    const pc = address(BigInt('0x' + match[1]), i + 1);
    const bytes = (match[2].match(/../g) || []).map(b => parseInt(b, 16));
    if (pc + bytes.length > MEMORY_SIZE) throw new AssemblyError(i + 1, '.yo 超出内存范围');
    bytes.forEach((b, offset) => { if (used.has(pc + offset)) throw new AssemblyError(i + 1, '重复的 .yo 字节地址'); used.add(pc + offset); memory[pc + offset] = b; });
    if (bytes.length) { entries++; listing.set(pc, { pc: BigInt(pc), line: i + 1, text: match[3] || '', bytes, isData: /^\s*\./.test(match[3] || '') }); }
  });
  if (!entries) throw new AssemblyError(1, '.yo 文件中没有目标代码');
  return { memory, listing, labels: new Map(), source, used };
}

export function readWord(memory, address) {
  if (address < 0n || address > BigInt(memory.length - 8)) throw new RangeError('ADR');
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(memory[Number(address) + i]);
  return i64(value);
}
export function writeWord(memory, address, value) {
  if (address < 0n || address > BigInt(memory.length - 8)) throw new RangeError('ADR');
  value = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i++) { memory[Number(address) + i] = Number(value & 255n); value >>= 8n; }
}

export function condition(ifun, cc) {
  const less = cc.SF !== cc.OF;
  return [true, less || cc.ZF, less, cc.ZF, !cc.ZF, !less, !less && !cc.ZF][ifun] ?? false;
}

export function alu(ifun, a, b) {
  let result;
  if (ifun === 1) result = i64(b - a);
  else if (ifun === 2) result = i64(b & a);
  else if (ifun === 3) result = i64(b ^ a);
  else result = i64(b + a);
  const OF = ifun === 0 ? ((a < 0n) === (b < 0n) && (result < 0n) !== (b < 0n)) : ifun === 1 ? ((a < 0n) !== (b < 0n) && (result < 0n) !== (b < 0n)) : false;
  return { result, cc: { ZF: result === 0n, SF: result < 0n, OF } };
}

export function decode(memory, pc) {
  const base = { pc, stat: 'AOK', icode: OP.NOP, ifun: 0, rA: NONE, rB: NONE, valC: 0n, valP: pc, uid: 0, text: '' };
  if (pc < 0n || pc >= BigInt(memory.length)) return { ...base, stat: 'ADR', text: '地址异常' };
  const byte = memory[Number(pc)], icode = byte >> 4, ifun = byte & 15;
  const regs = [2, 3, 4, 5, 6, 10, 11, 12].includes(icode), imm = [3, 4, 5, 7, 8, 12].includes(icode);
  const size = 1 + (regs ? 1 : 0) + (imm ? 8 : 0);
  const result = { ...base, icode, ifun, valP: pc + BigInt(size) };
  if (pc + BigInt(size) > BigInt(memory.length)) return { ...result, stat: 'ADR', text: '地址异常' };
  if (icode > 12 || ([2, 7].includes(icode) ? ifun > 6 : icode === 6 ? ifun > 3 : ifun !== 0)) return { ...result, stat: 'INS', text: '非法指令' };
  if (regs) { result.rA = memory[Number(pc) + 1] >> 4; result.rB = memory[Number(pc) + 1] & 15; }
  const validReg = r => r >= 0 && r < 15;
  if (([2, 4, 5, 6].includes(icode) && (!validReg(result.rA) || !validReg(result.rB))) || ([3, 12].includes(icode) && (result.rA !== NONE || !validReg(result.rB))) || ([10, 11].includes(icode) && (!validReg(result.rA) || result.rB !== NONE))) return { ...result, stat: 'INS', text: '非法寄存器编码' };
  if (imm) result.valC = readWord(memory, pc + (regs ? 2n : 1n));
  if (icode === 0) result.stat = 'HLT';
  result.text = disassemble(result);
  return result;
}

export function disassemble(s) {
  const a = regName(s.rA), b = regName(s.rB), immediate = hex(s.valC);
  return ['halt', 'nop', `${s.ifun ? 'cmov' + CONDITIONS[s.ifun] : 'rrmovq'} ${a}, ${b}`, `irmovq $${immediate}, ${b}`, `rmmovq ${a}, ${s.valC}(${b})`, `mrmovq ${s.valC}(${b}), ${a}`, `${ALUS[s.ifun]} ${a}, ${b}`, `${s.ifun ? 'j' + CONDITIONS[s.ifun] : 'jmp'} ${immediate}`, `call ${immediate}`, 'ret', `pushq ${a}`, `popq ${a}`, `iaddq $${immediate}, ${b}`][s.icode] || '非法指令';
}

export const bubble = () => ({ stat: 'BUB', icode: OP.NOP, ifun: 0, rA: NONE, rB: NONE, srcA: NONE, srcB: NONE, dstE: NONE, dstM: NONE, valC: 0n, valP: 0n, valA: 0n, valB: 0n, valE: 0n, valM: 0n, Cnd: false, pc: 0n, uid: 0, text: 'bubble' });

export class Pipeline {
  constructor(program) {
    this.program = program; this.memory = program.memory.slice(); this.regs = Array(15).fill(0n);
    this.cc = { ZF: true, SF: false, OF: false }; this.F = { predPC: 0n };
    this.D = bubble(); this.E = bubble(); this.M = bubble(); this.W = bubble();
    this.cycle = 0; this.retired = 0; this.status = 'AOK'; this.nextUid = 1;
    this.stalls = 0; this.flushes = 0; this.events = []; this.trace = []; this.last = null; this.changedRegs = []; this.changedMemory = [];
  }
  evaluate() {
    const { D, E, M, W } = this;
    const writeback = [];
    if (W.stat === 'AOK') {
      if (W.dstE !== NONE) writeback.push({ reg: W.dstE, value: W.valE, kind: 'valE' });
      if (W.dstM !== NONE) writeback.push({ reg: W.dstM, value: W.valM, kind: 'valM' });
    }
    let m_stat = M.stat, m_valM = 0n, memoryRead = false, memoryWrite = false, memoryAddress = 0n;
    if (M.stat === 'AOK') {
      memoryRead = [OP.LOAD, OP.POP, OP.RET].includes(M.icode);
      memoryWrite = [OP.STORE, OP.PUSH, OP.CALL].includes(M.icode) && !isTerminal(W.stat);
      memoryAddress = [OP.POP, OP.RET].includes(M.icode) ? M.valA : M.valE;
      if (memoryRead || memoryWrite) {
        try { m_valM = readWord(this.memory, memoryAddress); } catch { m_stat = 'ADR'; memoryRead = false; memoryWrite = false; }
      }
      if (!memoryRead) m_valM = 0n;
    }
    let aluA = 0n, aluB = 0n;
    if ([OP.MOV, OP.ALU].includes(E.icode)) aluA = E.valA;
    if ([OP.IMM, OP.STORE, OP.LOAD, OP.IADD].includes(E.icode)) aluA = E.valC;
    if ([OP.PUSH, OP.CALL].includes(E.icode)) aluA = -8n;
    if ([OP.POP, OP.RET].includes(E.icode)) aluA = 8n;
    if ([OP.STORE, OP.LOAD, OP.ALU, OP.PUSH, OP.POP, OP.CALL, OP.RET, OP.IADD].includes(E.icode)) aluB = E.valB;
    const aluFunction = E.icode === OP.ALU ? E.ifun : 0, execution = alu(aluFunction, aluA, aluB);
    const e_Cnd = condition(E.ifun, this.cc), e_dstE = E.icode === OP.MOV && !e_Cnd ? NONE : E.dstE;
    const setCC = E.stat === 'AOK' && [OP.ALU, OP.IADD].includes(E.icode) && !isTerminal(m_stat) && !isTerminal(W.stat);
    const srcA = [OP.MOV, OP.STORE, OP.ALU, OP.PUSH].includes(D.icode) ? D.rA : [OP.POP, OP.RET].includes(D.icode) ? RSP : NONE;
    const srcB = [OP.ALU, OP.STORE, OP.LOAD, OP.IADD].includes(D.icode) ? D.rB : [OP.PUSH, OP.POP, OP.CALL, OP.RET].includes(D.icode) ? RSP : NONE;
    const dstE = [OP.MOV, OP.IMM, OP.ALU, OP.IADD].includes(D.icode) ? D.rB : [OP.PUSH, OP.POP, OP.CALL, OP.RET].includes(D.icode) ? RSP : NONE;
    const dstM = [OP.LOAD, OP.POP].includes(D.icode) ? D.rA : NONE;
    const forwards = [];
    const resolve = (reg, port) => {
      if (reg === NONE) return 0n;
      const candidates = [[e_dstE, execution.result, 'E → D', E], [M.dstM, m_valM, 'M (valM) → D', M], [M.dstE, M.valE, 'M (valE) → D', M], [W.dstM, W.valM, 'W (valM) → D', W], [W.dstE, W.valE, 'W (valE) → D', W]];
      for (const [target, value, from, stage] of candidates) if (target === reg && stage.stat === 'AOK') { forwards.push({ from, port, reg, value }); return value; }
      return this.regs[reg];
    };
    const d_valA = [OP.CALL, OP.JUMP].includes(D.icode) ? D.valP : resolve(srcA, 'A');
    const d_valB = resolve(srcB, 'B');
    const loadUse = E.stat === 'AOK' && [OP.LOAD, OP.POP].includes(E.icode) && E.dstM !== NONE && [srcA, srcB].includes(E.dstM);
    const ret = [D, E, M].some(s => s.stat === 'AOK' && s.icode === OP.RET);
    const mispredict = E.stat === 'AOK' && E.icode === OP.JUMP && !e_Cnd;
    const F_stall = loadUse || ret, D_stall = loadUse, D_bubble = mispredict || (!loadUse && ret), E_bubble = mispredict || loadUse;
    const M_bubble = isTerminal(m_stat) || isTerminal(W.stat), W_stall = isTerminal(W.stat);
    const correction = M.stat === 'AOK' && M.icode === OP.JUMP && !M.Cnd;
    const returnPC = W.stat === 'AOK' && W.icode === OP.RET;
    const f_pc = correction ? M.valA : returnPC ? W.valM : this.F.predPC;
    const fetched = decode(this.memory, f_pc);
    const f_predPC = [OP.JUMP, OP.CALL].includes(fetched.icode) ? fetched.valC : fetched.valP;
    return { writeback, m_stat, m_valM, memoryRead, memoryWrite, memoryAddress, aluA, aluB, aluFunction, e_valE: execution.result, e_Cnd, e_dstE, setCC, newCC: execution.cc, srcA, srcB, dstE, dstM, d_valA, d_valB, forwards, loadUse, ret, mispredict, F_stall, D_stall, D_bubble, E_bubble, M_bubble, W_stall, f_pc, f_predPC, fetched, pcReason: correction ? '分支纠正' : returnPC ? 'ret 返回地址' : '预测 PC' };
  }
  step() {
    if (this.status !== 'AOK') return false;
    const s = this.evaluate();
    this.changedRegs = []; this.changedMemory = [];
    if (isTerminal(this.W.stat)) { this.status = this.W.stat; return false; }
    for (const write of s.writeback) { this.regs[write.reg] = write.value; this.changedRegs.push(write.reg); }
    if (this.W.stat === 'AOK') this.retired++;
    if (s.memoryWrite) { writeWord(this.memory, s.memoryAddress, this.M.valA); for (let i = 0; i < 8; i++) this.changedMemory.push(Number(s.memoryAddress) + i); }
    if (s.setCC) this.cc = s.newCC;
    const fetched = { ...s.fetched, uid: this.nextUid };
    const old = { F: { ...this.F }, D: this.D, E: this.E, M: this.M, W: this.W };
    const nextW = s.W_stall ? this.W : { ...this.M, stat: s.m_stat, valM: s.m_valM };
    const nextM = s.M_bubble ? bubble() : { ...this.E, Cnd: s.e_Cnd, dstE: s.e_dstE, valE: s.e_valE };
    const nextE = s.E_bubble ? bubble() : { ...this.D, srcA: s.srcA, srcB: s.srcB, dstE: s.dstE, dstM: s.dstM, valA: s.d_valA, valB: s.d_valB };
    const nextD = s.D_stall ? this.D : s.D_bubble ? bubble() : fetched;
    // A discarded speculative fetch still has its own dynamic identity.
    if (!s.D_stall) this.nextUid++;
    if (!s.F_stall) this.F = { predPC: s.f_predPC };
    this.D = nextD; this.E = nextE; this.M = nextM; this.W = nextW; this.cycle++;
    this.last = { ...s, old, fetched };
    if (s.loadUse || s.ret) this.stalls++;
    if (s.mispredict) this.flushes++;
    const events = [];
    if (s.loadUse) events.push({ type: 'stall', message: `load/use：${regName(old.E.dstM)} 尚在访存途中；保持 F、D，在 E 插入气泡。` });
    if (s.mispredict) events.push({ type: 'flush', message: '分支预测失败：预测跳转，实际不跳转；清空 D、E，下一周期纠正 PC。' });
    if (s.ret && !s.loadUse) events.push({ type: 'stall', message: 'ret：暂停取指，等待返回地址从内存到达 W。' });
    if (s.forwards.length && old.D.stat === 'AOK' && !s.E_bubble) events.push({ type: 'forward', message: s.forwards.map(f => `${f.from}：${regName(f.reg)} = ${hex(f.value)} → val${f.port}`).join('；') });
    if (s.memoryRead) events.push({ type: 'memory', message: `读取 M[${hex(s.memoryAddress)}] = ${hex(s.m_valM)}` });
    if (s.memoryWrite) events.push({ type: 'memory', message: `写入 M[${hex(s.memoryAddress)}] = ${hex(old.M.valA)}` });
    this.events.unshift(...events.map(event => ({ ...event, cycle: this.cycle })));
    this.events.length = Math.min(this.events.length, 160);
    this.trace.push({ cycle: this.cycle, stages: { F: fetched, D: old.D, E: old.E, M: old.M, W: old.W }, loadUse: s.loadUse, ret: s.ret, mispredict: s.mispredict, F_stall: s.F_stall, D_stall: s.D_stall, D_bubble: s.D_bubble });
    if (this.trace.length > 500) this.trace.shift();
    if (isTerminal(this.W.stat)) { this.status = this.W.stat; if (this.W.stat === 'HLT') this.retired++; }
    return true;
  }
  run(limit = 10000) { while (this.status === 'AOK' && this.cycle < limit) this.step(); return this; }
  snapshot() {
    return { memory: this.memory.slice(), regs: [...this.regs], cc: { ...this.cc }, F: { ...this.F }, D: { ...this.D }, E: { ...this.E }, M: { ...this.M }, W: { ...this.W }, cycle: this.cycle, retired: this.retired, status: this.status, nextUid: this.nextUid, stalls: this.stalls, flushes: this.flushes, events: [...this.events], trace: [...this.trace], last: this.last, changedRegs: [...this.changedRegs], changedMemory: [...this.changedMemory] };
  }
  restore(state) { Object.assign(this, state, { memory: state.memory.slice(), regs: [...state.regs], cc: { ...state.cc }, F: { ...state.F }, D: { ...state.D }, E: { ...state.E }, M: { ...state.M }, W: { ...state.W }, events: [...state.events], trace: [...state.trace] }); }
}
