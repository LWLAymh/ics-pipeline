import { assemble, Pipeline, REGISTERS, OP, NONE, hex, regName, readWord, MEMORY_SIZE, isTerminal, FORWARD_PATHS } from './core.js';
import { EXAMPLES } from './examples.js';
import { buildTimeline, renderTimeline } from './timeline.js';
import { CONNECTIONS, FORWARD_CONNECTIONS, forwardingState } from './connections.js';

const $ = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const COLORS = { F: '#1c899b', D: '#8166b1', E: '#c78d2e', M: '#358675', W: '#b56783' };
const STAGE_NAMES = { F: ['取指', 'FETCH'], D: ['译码', 'DECODE'], E: ['执行', 'EXECUTE'], M: ['访存', 'MEMORY'], W: ['写回', 'WRITE BACK'] };
let simulator, program, history = [], running = false, timer = null, pulseTimer = null, dirty = false;
let currentTab = 'registers', numberFormat = 'hex', memoryStart = 0x100, runUntil = 5000, compiledSource = '', selectedExample = EXAMPLES[0];
let visualization = new URL(window.location.href).searchParams.get('view') === 'timeline' ? 'timeline' : 'datapath';
let focusScroll = 0;
const forwardingConfig = Object.fromEntries(FORWARD_PATHS.map(id => [id, true]));
let selectedWire = 'forward-e', wireStates = new Map();
const source = $('source');
const valueText = value => numberFormat === 'dec' ? String(value) : hex(value, 16);
const shortHex = value => { const text = hex(value); return text.length > 14 ? text.slice(0, 6) + '…' + text.slice(-5) : text; };
const tooltip = text => `<title>${escape(text)}</title>`;

function toast(message) {
  document.querySelector('.toast')?.remove();
  const element = document.createElement('div'); element.className = 'toast'; element.role = 'status'; element.textContent = message;
  document.body.append(element); setTimeout(() => element.remove(), 4000);
}

function saveDraft() { try { localStorage.setItem('ics-pipeline-source-v1', source.value); } catch { /* Storage may be disabled; simulation remains available. */ } }
function lineNumbers() { $('line-numbers').textContent = source.value.split('\n').map((_, i) => i + 1).join('\n'); $('line-numbers').scrollTop = source.scrollTop; }
function setExampleNote(example) {
  $('example-title').textContent = example?.title || '观察自己的程序';
  $('example-description').textContent = example?.description || '逐周期观察数据依赖、转发和流水线控制；打开「事件」查看每次暂停与气泡的原因。';
}

function compile() {
  stop(false);
  try {
    const next = assemble(source.value);
    program = next; simulator = new Pipeline(next, { forwarding: forwardingConfig }); history = []; dirty = false; compiledSource = source.value;
    $('assembly-error').hidden = true; source.removeAttribute('aria-invalid');
    const objectCode = /^\s*0x[\da-f]+\s*:/im.test(source.value);
    $('file-type').textContent = objectCode ? '.yo' : '.ys'; $('export-button').textContent = objectCode ? '下载 .yo' : '下载 .ys';
    $('source-info').textContent = `Y86-64 · ${next.used.size} 字节 · ${next.labels.size} 个标签`;
    saveDraft(); render();
    return true;
  } catch (error) {
    dirty = true; $('assembly-error').hidden = false; $('assembly-error').textContent = error.message;
    source.setAttribute('aria-invalid', 'true'); render();
    $('notice-text').textContent = '编译失败，请修改标出的汇编错误后重新编译。'; $('cycle-notice').className = 'cycle-notice error';
    return false;
  }
}

function reset() {
  if (!program) return;
  stop(false); simulator = new Pipeline(program, { forwarding: forwardingConfig }); history = []; render();
}
function remember() { history.push(simulator.snapshot()); if (history.length > 120) history.shift(); }
function step() {
  if (!simulator || dirty || simulator.status !== 'AOK') return;
  remember(); simulator.step(); render();
  if ($('animate').checked) { $('datapath').classList.add('flow'); clearTimeout(pulseTimer); pulseTimer = setTimeout(() => { pulseTimer = null; if (!running) $('datapath').classList.remove('flow'); }, 650); }
  if (simulator.status !== 'AOK') stop();
}
function back() { stop(false); const previous = history.pop(); if (previous) simulator.restore(previous); render(); }
function stop(refresh = true) { running = false; clearTimeout(timer); timer = null; if (!$('animate').checked || !pulseTimer) $('datapath').classList.remove('flow'); if (refresh && simulator) render(); }
function tick() {
  if (!running) return;
  step();
  if (!running) return;
  if (simulator.cycle >= runUntil) { stop(); toast('已连续运行 5,000 周期并暂停。可继续运行，或后退检查状态。'); return; }
  timer = setTimeout(tick, 1000 / Number($('speed').value));
}
function toggleRun() {
  if (running) return stop();
  if (!simulator || dirty || simulator.status !== 'AOK') return;
  running = true; runUntil = simulator.cycle + 5000; render(); tick();
}

function render() {
  if (!simulator) { $('step').disabled = true; $('run').disabled = true; $('back').disabled = true; return; }
  const s = simulator.evaluate();
  $('cycle-count').textContent = simulator.cycle;
  $('instruction-count').textContent = simulator.retired;
  $('cpi-count').textContent = simulator.retired ? (simulator.cycle / simulator.retired).toFixed(2) : '—';
  $('status-pill').textContent = dirty ? '待编译' : running ? '运行中 · AOK' : simulator.status === 'HLT' ? '已停止 · HLT' : simulator.status === 'AOK' ? '就绪 · AOK' : `异常 · ${simulator.status}`;
  $('status-pill').className = 'status-pill' + (simulator.status === 'HLT' ? ' halted' : ['ADR', 'INS'].includes(simulator.status) ? ' error' : '');
  $('step').disabled = dirty || simulator.status !== 'AOK' || running;
  $('run').disabled = dirty || simulator.status !== 'AOK';
  $('run').innerHTML = running ? '<span aria-hidden="true">Ⅱ</span> 暂停' : '<span aria-hidden="true">▶</span> 运行';
  $('back').disabled = history.length === 0 || dirty;
  $('reset').disabled = dirty || simulator.cycle === 0;
  $('edit-state').textContent = dirty ? '有修改 · 请编译' : '已编译'; $('edit-state').className = 'small-muted' + (dirty ? ' dirty' : '');
  $('hazard-count').textContent = `${simulator.stalls} 暂停 · ${simulator.flushes} 预测失败`;
  $('forwarding-summary').textContent = `${Object.values(forwardingConfig).filter(Boolean).length} / 5 条路径开启`;
  renderNotice(s);
  $('datapath-panel').hidden = visualization !== 'datapath';
  $('timeline-panel').hidden = visualization !== 'timeline';
  if (visualization === 'timeline') {
    const model = buildTimeline(program, simulator);
    renderTimeline($('cycle-animation'), model, $('animate').checked, { scale: Number($('timeline-zoom').value), follow: $('timeline-follow').checked });
    $('timeline-range').textContent = `周期 ${model.firstCycle}–${model.cycle} · 单击方格单步`;
    $('cycle-animation').setAttribute('aria-disabled', String(dirty || running || simulator.status !== 'AOK'));
  }
  else renderDiagram(s);
  renderState(s);
  for (const key of ['ZF', 'SF', 'OF']) { const flag = $('flag-' + key); flag.classList.toggle('on', simulator.cc[key]); flag.querySelector('b').textContent = Number(simulator.cc[key]); }
  $('writeback-caption').textContent = simulator.changedRegs.length ? '刚写回 ' + [...new Set(simulator.changedRegs)].map(regName).join(' / ') : '等待写回';
}

function renderNotice(s) {
  let kind = '', message;
  if (dirty) message = '代码已修改，点击「编译 / 复位」后执行新程序。';
  else if (simulator.status === 'HLT') message = 'halt 已到达 W，程序停止。可后退查看过程，或复位重跑。';
  else if (simulator.status === 'ADR') { kind = 'error'; message = 'ADR：访存或取指地址越界。有效地址为 0x0000～0xffff；一次 8 字节访存须完整落在此范围。'; }
  else if (simulator.status === 'INS') { kind = 'error'; message = 'INS：取到了非法指令或寄存器编码。请检查跳转目标、.yo 内容，以及是否写坏了代码区。'; }
  else if (s.loadUse) { kind = 'stall'; message = `本周期 load/use：${regName(simulator.E.dstM)} 的加载结果尚未就绪。下个边沿保持 F、D，在 E 插入气泡。`; }
  else if (s.mispredict) { kind = 'flush'; message = '本周期分支预测失败：实际不跳转。下个边沿在 D、E 插入气泡，再从 M.valA 恢复顺序地址。'; }
  else if (s.dataStall) { kind = 'stall'; message = `转发等待：${s.blocked.map(b => `${regName(b.reg)} 的 ${b.path.replace('_', '.')} 路径已关闭`).join('；')}。保持 F、D，在 E 插入气泡，等待最新结果。`; }
  else if (s.ret) { kind = 'stall'; message = '本周期遇到 ret：保持 F，并在 D 插入气泡，等待返回地址到达 W。'; }
  else if (s.forwards.length && simulator.D.stat === 'AOK') message = '本周期转发：' + s.forwards.map(f => `${f.from}，${regName(f.reg)} = ${shortHex(f.value)} → val${f.port}`).join('；');
  else if (simulator.cycle === 0) message = '程序已编译。点击「单步」，观察指令进入五级流水线。';
  else message = '本周期正常推进。图中连线显示当前组合逻辑；点击「单步」将结果锁存到后一级。';
  $('cycle-notice').className = 'cycle-notice' + (kind ? ' ' + kind : ''); $('notice-text').textContent = message;
}

function renderDiagram(s) {
  const sim = simulator, live = sim.status === 'AOK' && !dirty;
  const f = s.fetched, stages = { F: f, D: sim.D, E: sim.E, M: sim.M, W: sim.W };
  const active = key => live && stages[key].stat === 'AOK';
  const controls = { F: s.F_stall ? 'STALL' : '', D: s.D_stall ? 'STALL' : s.D_bubble ? 'BUBBLE' : '', E: s.E_bubble ? 'BUBBLE' : '', M: s.M_bubble ? 'BUBBLE' : '', W: s.W_stall ? 'STALL' : '' };
  const cards = Object.entries(stages).map(([key, stage]) => {
    const isBubble = stage.stat === 'BUB', name = STAGE_NAMES[key], line = program.listing.get(Number(stage.pc))?.line;
    const text = isBubble ? '— bubble —' : key === 'F' && !live && !dirty ? '已停止取指' : stage.text;
    const control = !live ? '' : controls[key];
    return `<div class="stage-header" style="--stage:${COLORS[key]}"><div class="stage-name"><span class="stage-letter">${key}</span>${name[0]} <span class="stage-subtitle">${name[1]}</span>${control ? `<span class="stage-control ${control === 'BUBBLE' ? 'bubble' : ''}" title="下一个时钟边沿将执行 ${control}">${control}</span>` : ''}</div><div class="stage-instruction ${isBubble ? 'empty' : ''}" title="${escape(stage.text)}">${escape(text)}</div><div class="stage-pc">${isBubble ? 'PC —' : `PC ${hex(stage.pc, 4)}`}<span class="source-line">${isBubble || !line ? '' : `L${line}`}</span></div></div>`;
  }).join('');
  wireStates = new Map();
  const wire = (id, d, enabled, color, description, extra = '') => {
    const definition = CONNECTIONS[id], disabled = definition.path && !sim.forwarding[definition.path];
    wireStates.set(id, { active: Boolean(enabled), description });
    return `<g class="wire-group ${selectedWire === id ? 'selected' : ''} ${disabled ? 'disabled' : ''}" data-wire="${id}" role="button" tabindex="0" aria-label="查看${escape(definition.title)}连线">${tooltip(definition.title + '：' + description)}<path id="${id}" class="wire ${extra} ${enabled ? 'active' : ''}" style="--wire-color:${color}" d="${d}"/><path class="wire-hit" d="${d}"/></g>`;
  };
  const label = (x, y, text, cls = 'wire-label', anchor = '') => `<text x="${x}" y="${y}" class="${cls}" ${anchor ? `text-anchor="${anchor}"` : ''}>${escape(text)}</text>`;
  const numeric = (x, y, value, prefix = '') => `<text x="${x}" y="${y}" class="component-value">${tooltip(`${prefix}${hex(value, 16)} / ${value}`)}${escape(shortHex(value))}</text>`;
  const component = (key, x, y, w, h, title, lines = []) => `<g class="tap-target" style="--stage:${COLORS[key]}">${tooltip(title)}<rect class="component ${active(key) ? 'active' : ''}" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>${label(x + w / 2, y + 23, title, 'component-label', 'middle')}${lines.map((line, i) => label(x + w / 2, y + 44 + i * 19, line, 'component-value', 'middle')).join('')}</g>`;
  const port = (x, y, name, value) => `<g>${tooltip(name + ': ' + (typeof value === 'bigint' ? hex(value, 16) + ' / ' + value : value))}${label(x, y, name, 'port-name')}${label(x, y + 13, typeof value === 'bigint' ? shortHex(value) : value, 'port-value')}</g>`;
  const pipelineReg = (x, name, key) => `<g style="--stage:${COLORS[key]}"><rect class="pipeline-reg ${active(key) ? 'active' : ''}" x="${x}" y="110" width="22" height="216" rx="3"/>${label(x + 11, 343, name, 'pipeline-label')}</g>`;
  const forwarding = prefix => live && sim.D.stat === 'AOK' && s.forwards.some(f => f.from.startsWith(prefix));
  const codeA = active('D'), codeE = active('E'), codeM = active('M'), codeW = active('W');
  const svg = `<svg viewBox="0 0 1440 450" role="img" aria-labelledby="datapath-title datapath-desc"><title id="datapath-title">Y86-64 PIPE 数据通路</title><desc id="datapath-desc">五级流水线含取指、译码、执行、访存和双端口写回。彩色连线显示当前有效信号；底部紫色连线表示数据转发。</desc>
    <defs><marker id="signal-start" markerWidth="6" markerHeight="6" refX="3" refY="3"><circle cx="3" cy="3" r="2" fill="#197d86"/></marker><marker id="signal-end" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7 Z" fill="#197d86"/></marker><pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".65" class="diagram-dot"/></pattern></defs><rect x="0" y="0" width="1440" height="450" fill="url(#dots)"/>
    ${[256,576,856,1136].map(x => `<path class="stage-separator" d="M${x} 12 V432"/>`).join('')}
    ${wire('pc-prediction', 'M221 80 H235 V22 H10 V80 H34', active('F') && s.pcReason === '预测 PC', COLORS.F, `F.predPC = ${hex(sim.F.predPC)}；${[OP.JUMP,OP.CALL].includes(f.icode) ? '预测目标地址' : '顺序地址 valP'}`)}
    ${wire('pc-branch', 'M867 284 H879 V38 H22 V92 H34', live && s.pcReason === '分支纠正', '#bc6d83', `分支预测失败时 f_pc = M.valA = ${hex(sim.M.valA)}`, 'control')}
    ${wire('pc-return', 'M1356 229 H1408 V9 H17 V103 H34', live && s.pcReason === 'ret 返回地址', '#bc6d83', `ret 返回地址 f_pc = W.valM = ${hex(sim.W.valM)}`, 'control')}
    ${wire('pc-output', 'M70 80 H93 V149 H60 V163', live, COLORS.F, `f_pc (${s.pcReason}) = ${hex(s.f_pc)}`)}
    ${wire('pc-imem', 'M93 185 H137', active('F'), COLORS.F, `指令内存地址 = ${hex(s.f_pc)}`)}
    ${wire('pc-increment', 'M111 185 V80 H151', active('F'), COLORS.F, `根据指令长度计算 valP = ${hex(f.valP)}`)}
    ${wire('instruction-bus', 'M231 190 H245', live, COLORS.F, `f_icode = ${f.icode}, f_ifun = ${f.ifun}, f_stat = ${f.stat}`)}
    ${wire('decode-bus', 'M267 190 H342', codeA, COLORS.D, `D.rA = ${regName(sim.D.rA)}, D.rB = ${regName(sim.D.rB)}`)}
    ${wire('decode-valp', 'M267 124 H295 V285 H565', codeA && [OP.CALL,OP.JUMP].includes(sim.D.icode), COLORS.D, `call / jXX 的 d_valA = D.valP = ${hex(sim.D.valP)}`)}
    ${wire('decode-valc', 'M267 311 H565', codeA && [OP.IMM,OP.LOAD,OP.STORE,OP.IADD].includes(sim.D.icode), COLORS.D, `D.valC = ${hex(sim.D.valC)}`)}
    ${wire('register-a', 'M482 182 H502', codeA && s.srcA !== NONE, COLORS.D, `R[${regName(s.srcA)}] = ${hex(sim.regs[s.srcA] ?? 0n)}`)}
    ${wire('register-b', 'M482 230 H502', codeA && s.srcB !== NONE, COLORS.D, `R[${regName(s.srcB)}] = ${hex(sim.regs[s.srcB] ?? 0n)}`)}
    ${wire('decode-a', 'M540 182 H565', codeA && s.srcA !== NONE && !s.E_bubble, COLORS.D, s.blocked.some(b=>b.port==='A') ? 'd_valA：等待最新结果，本周期不锁存' : `d_valA = ${hex(s.d_valA)}；${s.forwards.find(f=>f.port==='A')?.from || '寄存器文件'}`)}
    ${wire('decode-b', 'M540 230 H565', codeA && s.srcB !== NONE && !s.E_bubble, COLORS.D, s.blocked.some(b=>b.port==='B') ? 'd_valB：等待最新结果，本周期不锁存' : `d_valB = ${hex(s.d_valB)}；${s.forwards.find(f=>f.port==='B')?.from || '寄存器文件'}`)}
    ${wire('alu-a-register', 'M587 182 H639', codeE && [OP.MOV,OP.ALU].includes(sim.E.icode), COLORS.E, `E.valA = ${hex(sim.E.valA)}`)}
    ${wire('alu-a-immediate', 'M587 311 H614 V198 H639', codeE && [OP.IMM,OP.LOAD,OP.STORE,OP.IADD].includes(sim.E.icode), COLORS.E, `E.valC = ${hex(sim.E.valC)}`)}
    ${wire('alu-a', 'M673 177 H720', codeE, COLORS.E, `aluA = ${hex(s.aluA)}`)}
    ${wire('alu-b-register', 'M587 230 H633 V249 H641', codeE && [OP.ALU,OP.LOAD,OP.STORE,OP.CALL,OP.RET,OP.PUSH,OP.POP,OP.IADD].includes(sim.E.icode), COLORS.E, `E.valB = ${hex(sim.E.valB)}`)}
    ${wire('alu-b', 'M675 248 H699 V234 H720', codeE, COLORS.E, `aluB = ${hex(s.aluB)}`)}
    ${wire('alu-result', 'M780 202 H845', codeE, COLORS.E, `e_valE = ${hex(s.e_valE)} / ${s.e_valE}`)}
    ${wire('execute-pass-a', 'M587 182 H603 V284 H845', codeE && [OP.STORE,OP.PUSH,OP.CALL,OP.POP,OP.RET,OP.JUMP].includes(sim.E.icode), COLORS.E, `E.valA = ${hex(sim.E.valA)}，传往 M，供写入、栈读取或分支纠正使用`)}
    ${wire('condition-test', 'M747 318 V291 H809 V125', codeE && [OP.MOV,OP.JUMP].includes(sim.E.icode), COLORS.E, `e_Cnd = ${Number(s.e_Cnd)}，条件码 ZF=${Number(sim.cc.ZF)} SF=${Number(sim.cc.SF)} OF=${Number(sim.cc.OF)}`)}
    ${wire('condition-out', 'M835 105 H845', codeE && sim.E.icode===OP.JUMP, COLORS.E, `分支条件 e_Cnd = ${Number(s.e_Cnd)}`)}
    ${wire('memory-address', 'M867 202 H927', codeM && [OP.LOAD,OP.STORE,OP.PUSH,OP.CALL].includes(sim.M.icode), COLORS.M, `访存地址 M.valE = ${hex(s.memoryAddress)}`)}
    ${wire('memory-stack-address', 'M867 284 H905 V225 H927', codeM && [OP.RET,OP.POP].includes(sim.M.icode), COLORS.M, `栈读取地址 M.valA = ${hex(s.memoryAddress)}`)}
    ${wire('memory-write-data', 'M867 284 H890 V249 H927', codeM && s.memoryWrite, COLORS.M, `写入的数据 M.valA = ${hex(sim.M.valA)}`)}
    ${wire('memory-read', 'M1057 229 H1125', codeM && s.memoryRead, COLORS.M, `m_valM = M[${hex(s.memoryAddress)}] = ${hex(s.m_valM)}`)}
    ${wire('memory-pass', 'M867 202 H881 V147 H1125', codeM && sim.M.dstE!==NONE, COLORS.M, `M.valE = ${hex(sim.M.valE)}，传往 W`)}
    ${wire('wb-e-input', 'M1147 147 H1186 V180 H1220', codeW && sim.W.dstE!==NONE, COLORS.W, `W.valE = ${hex(sim.W.valE)}, W.dstE = ${regName(sim.W.dstE)}`)}
    ${wire('wb-m-input', 'M1147 229 H1220', codeW && sim.W.dstM!==NONE, COLORS.W, `W.valM = ${hex(sim.W.valM)}, W.dstM = ${regName(sim.W.dstM)}`)}
    ${wire('wb-e', 'M1365 180 H1380 V415 H322 V248 H342', codeW && sim.W.dstE!==NONE, COLORS.W, `写回端口 E：${regName(sim.W.dstE)} ← ${hex(sim.W.valE)}`)}
    ${wire('wb-m', 'M1365 229 H1395 V431 H310 V263 H342', codeW && sim.W.dstM!==NONE, COLORS.W, `写回端口 M：${regName(sim.W.dstM)} ← ${hex(sim.W.valM)}（相同目标时优先）`)}
    ${wire('forward-e', 'M811 202 V356 H520 V258', forwarding('E'), '#9971ce', s.forwards.filter(f=>f.from.startsWith('E')).map(f=>`${f.from} ${regName(f.reg)}=${hex(f.value)} → val${f.port}`).join('；') || '执行结果转发：e_valE → D', 'forward')}
    ${wire('forward-m', 'M1082 229 V372 H530 V258', forwarding('M (valM)'), '#9971ce', s.forwards.filter(f=>f.from.startsWith('M (valM)')).map(f=>`${f.from} ${regName(f.reg)}=${hex(f.value)} → val${f.port}`).join('；') || '内存读取结果转发：m_valM → D', 'forward')}
    ${wire('forward-m-e', 'M1094 147 V365 H540 V258', forwarding('M (valE)'), '#9971ce', s.forwards.filter(f=>f.from.startsWith('M (valE)')).map(f=>`${f.from} ${regName(f.reg)}=${hex(f.value)} → val${f.port}`).join('；') || '访存级 ALU 结果转发：M.valE → D', 'forward')}
    ${wire('forward-w-e', 'M1203 180 V398 H508 V258', live && s.forwards.some(f=>f.path==='W_valE'), '#9971ce', '写回级 ALU 结果：W.valE = '+hex(sim.W.valE,16)+' → D', 'forward')}
    ${wire('forward-w-m', 'M1209 229 V405 H514 V258', live && s.forwards.some(f=>f.path==='W_valM'), '#9971ce', '写回级加载结果：W.valM = '+hex(sim.W.valM,16)+' → D', 'forward')}
    ${[[811,202,'E_valE'],[1082,229,'M_valM'],[1094,147,'M_valE'],[1203,180,'W_valE'],[1209,229,'W_valM']].map(([x,y,path])=>`<circle class="wire-junction ${sim.forwarding[path]?'':'disabled'}" cx="${x}" cy="${y}" r="2.8"/>`).join('')}
    ${pipelineReg(245,'F / D','D')}${pipelineReg(565,'D / E','E')}${pipelineReg(845,'E / M','M')}${pipelineReg(1125,'M / W','W')}
    <path class="mux ${live ? 'active' : ''}" d="M34 58 L70 70 V104 L34 117 Z"/>${label(49,91,'PC','mux-label')}
    ${component('F',27,163,66,48,'PC')}${numeric(35,200,s.f_pc)}
    ${component('F',137,143,94,92,'指令内存',['Instruction', 'memory'])}
    ${component('F',151,55,70,50,'PC + len')}${numeric(159,94,f.valP)}
    ${component('D',342,139,140,139,'寄存器文件',[`srcA  ${regName(s.srcA)}`,`srcB  ${regName(s.srcB)}`])}
    ${numeric(354,226,sim.regs[s.srcA]??0n)}${numeric(354,251,sim.regs[s.srcB]??0n)}
    <g>${tooltip('转发选择器：E.valE → M.valM → M.valE → W.valM → W.valE → 寄存器文件；按从左到右的优先级选择。')}<rect class="mux ${s.forwards.length && live ? 'active' : ''}" x="502" y="164" width="38" height="94" rx="5"/><text x="521" y="213" class="mux-label" transform="rotate(-90 521 213)">FORWARD</text></g>
    <path class="mux ${codeE ? 'active' : ''}" d="M639 146 L673 159 V199 L639 212 Z"/>${label(653,181,'A','mux-label')}
    <path class="mux ${codeE ? 'active' : ''}" d="M641 226 L675 238 V263 L641 276 Z"/>${label(655,253,'B','mux-label')}
    <g style="--stage:${COLORS.E}">${tooltip(`ALU ${['ADD','SUB','AND','XOR'][s.aluFunction]}：${s.aluA}, ${s.aluB} → ${s.e_valE}`)}<path class="component ${codeE ? 'active' : ''}" d="M720 130 L780 160 V240 L720 270 V216 L738 200 L720 184 Z"/>${label(756,205,'ALU','component-label','middle')}</g>
    <g>${tooltip(`CC：ZF=${Number(sim.cc.ZF)} SF=${Number(sim.cc.SF)} OF=${Number(sim.cc.OF)}；本周期${s.setCC ? '更新' : '保持'}`)}<rect x="706" y="318" width="94" height="29" rx="5" class="cc-svg"/>${label(716,337,`CC  ${Number(sim.cc.ZF)} ${Number(sim.cc.SF)} ${Number(sim.cc.OF)}`,'component-value')}</g>
    ${component('E',785,85,50,40,'Cnd')}${label(810,117,Number(s.e_Cnd),'component-value','middle')}
    ${component('M',927,164,130,104,'数据内存',[s.memoryRead ? 'READ · 8 bytes' : s.memoryWrite ? 'WRITE · 8 bytes' : 'IDLE'])}
    ${numeric(941,244,(s.memoryRead||s.memoryWrite)?s.memoryAddress:0n)}
    ${component('W',1220,145,145,120,'双端口写回',[`valE → ${regName(sim.W.dstE)}`,`valM → ${regName(sim.W.dstM)}`])}
    ${label(1292,246,'E / M 两路可同时写回','wire-label','middle')}
    ${port(276,151,'icode / ifun',`${sim.D.icode} / ${sim.D.ifun}`)}
    ${port(589,131,'valA',sim.E.valA)}${port(589,280,'valB',sim.E.valB)}
    ${port(873,107,'Cnd',Number(sim.M.Cnd))}${port(873,174,'valE',sim.M.valE)}
    ${port(1153,119,'valE',sim.W.valE)}${port(1153,280,'valM',sim.W.valM)}
    ${label(100,178,'f_pc')}${label(157,130,'icode · ifun · rA · rB')}${label(358,128,'15 × 64-bit')}
    ${label(644,137,'valA / valC / ±8')}${label(645,294,'valB / 0')}${label(787,222,'e_valE')}
    ${label(953,158,'address')}${label(936,290,s.m_stat==='ADR'?'ADR · 地址越界':s.memoryRead?`valM ${shortHex(s.m_valM)}`:s.memoryWrite?`data ${shortHex(sim.M.valA)}`:'读 / 写使能')}
    ${label(683,365,'E → D','forward-caption')}${label(928,381,'M → D','forward-caption')}${label(1185,389,'W.valE / W.valM → D','forward-caption')}
    ${label(858,442,'WRITE BACK → REGISTER FILE','caption-svg','middle')}
  </svg>`;
  $('datapath').innerHTML = `<div class="stage-header-row">${cards}</div>${svg}`;
  $('datapath').classList.toggle('isolate-signal', $('isolate-signal').checked);
  $('datapath').classList.toggle('flow', $('animate').checked && (running || Boolean(pulseTimer)));
  renderSignalDetail(s);
}

function renderSignalDetail(s) {
  const def = CONNECTIONS[selectedWire], state = wireStates.get(selectedWire);
  $('signal-select').value = selectedWire;
  const info = def.path ? forwardingState(def.path, simulator, s) : null;
  const inactive = dirty || simulator.status !== 'AOK';
  const status = dirty ? '代码待编译' : inactive ? '处理器已停止' : info?.state || (state.active ? '本周期有效' : '本周期未使用');
  const currentValue = info ? info.dst === NONE || simulator[FORWARD_CONNECTIONS[def.path].stage].stat !== 'AOK' ? '当前级无有效的寄存器写入目标' : `候选值 ${hex(info.value,16)} / ${info.value} · 目标 ${regName(info.dst)}` : state.description;
  $('signal-detail').innerHTML = `<div class="signal-route"><div><span>起点 · ${def.width}</span><strong>${escape(def.from)}</strong></div><b aria-hidden="true">→</b><div><span>终点</span><strong>${escape(def.to)}</strong></div><span class="signal-status">${status}</span></div><p class="signal-rule">${escape(def.rule)}</p><div class="signal-value"><code>${escape(currentValue)}</code>${def.path ? `<button id="toggle-inspected-path" class="mini-button" data-path="${def.path}">${simulator.forwarding[def.path] ? '关闭此转发' : '开启此转发'}</button>` : ''}</div>`;
  $('operand-sources').innerHTML = `<span class="operand-heading">D 级当前操作数</span>${['A','B'].map(port=>{
    const operand = s.operands.find(op=>op.port===port);
    const text = !operand || simulator.D.stat!=='AOK' ? (port==='A' && [OP.CALL,OP.JUMP].includes(simulator.D.icode) && simulator.D.stat==='AOK' ? 'D.valP（顺序地址）' : '不读取寄存器') : `${regName(operand.reg)} ← ${operand.from}${operand.waiting ? ' · 等待，当前不锁存' : ' · '+shortHex(operand.value)}`;
    return `<span class="operand-chip ${operand?.waiting?'waiting':''}"><b>val${port}</b> ${escape(text)}</span>`;
  }).join('')}`;
}

function renderState(s) {
  const captions = { registers: '15 个通用寄存器 · 刚完成的写回高亮', pipeline: '当前锁存值 · 控制信号决定下个边沿的动作', timing: '动态指令 × 已执行周期 · 最近 40 列', memory: '8 字节小端字 · 刚完成的写入高亮', events: '最近发生的数据冒险、转发与访存' };
  $('view-caption').textContent = captions[currentTab]; $('number-options').hidden = !['registers','memory','pipeline'].includes(currentTab);
  const content = $('state-content'), scrollTop = content.scrollTop;
  if (currentTab === 'registers') {
    content.innerHTML = `<div class="register-grid">${REGISTERS.map((name, index) => `<div class="register-cell ${simulator.changedRegs.includes(index) ? 'changed' : ''}" title="${name} = ${hex(simulator.regs[index],16)} / ${simulator.regs[index]}"><div class="register-top"><span class="register-name">${name}</span><span class="register-index">${index.toString(16).toUpperCase().padStart(2,'0')}</span></div><span class="register-value">${escape(valueText(simulator.regs[index]))}</span></div>`).join('')}</div>`;
  } else if (currentTab === 'pipeline') renderPipeline(s);
  else if (currentTab === 'timing') renderTiming();
  else if (currentTab === 'memory') renderMemory(s);
  else if (currentTab === 'events') content.innerHTML = simulator.events.length ? simulator.events.map(e => `<div class="event ${e.type}"><span class="event-cycle">C${e.cycle}</span><div><span class="event-type">${e.type}</span><p>${escape(e.message)}</p></div></div>`).join('') : '<div class="empty-state"><span class="empty-symbol">↳</span>单步执行后，转发与冒险事件会显示在这里。</div>';
  content.scrollTop = scrollTop;
}

function renderPipeline(s) {
  const entries = { F: simulator.F, D: simulator.D, E: simulator.E, M: simulator.M, W: simulator.W };
  const fields = { F: ['predPC'], D: ['stat','icode','ifun','rA','rB','valC','valP'], E: ['stat','icode','ifun','srcA','srcB','dstE','dstM','valA','valB','valC'], M: ['stat','icode','Cnd','dstE','dstM','valE','valA'], W: ['stat','icode','dstE','dstM','valE','valM'] };
  const controls = { F: s.F_stall?'STALL':'LOAD', D:s.D_stall?'STALL':s.D_bubble?'BUBBLE':'LOAD', E:s.E_bubble?'BUBBLE':'LOAD', M:s.M_bubble?'BUBBLE':'LOAD', W:s.W_stall?'STALL':'LOAD' };
  $('state-content').innerHTML = `<div class="pipeline-cards">${Object.entries(entries).map(([key,stage]) => `<article class="pipeline-card" style="--stage:${COLORS[key]}"><h3>${key} · ${STAGE_NAMES[key][1]} <span style="float:right">${simulator.status==='AOK'?controls[key]:'FROZEN'}</span></h3><p class="instruction-text">${escape(key==='F'?`f_pc = ${hex(s.f_pc)} · ${s.pcReason}`:stage.text)}</p><div class="pipeline-fields">${fields[key].map(field => { let value=stage[field]; if (['rA','rB','srcA','srcB','dstE','dstM'].includes(field)) value=regName(value); else if(typeof value==='bigint') value=valueText(value); else if(typeof value==='boolean') value=Number(value); return `<span title="${escape(field+' = '+value)}">${field} <b>${escape(value)}</b></span>`; }).join('')}</div></article>`).join('')}</div>`;
}

function renderTiming() {
  const frames = simulator.trace.slice(-40), rows = new Map();
  if (!frames.length) { $('state-content').innerHTML = '<div class="empty-state"><span class="empty-symbol">F → D → E → M → W</span>先单步几次，在这里观察指令的重叠执行。</div>'; return; }
  for (const frame of frames) for (const [stage,inst] of Object.entries(frame.stages)) {
    if (!inst.uid || inst.stat==='BUB' || (stage==='F' && frame.ret && !frame.dataStall)) continue;
    if (!rows.has(inst.uid)) rows.set(inst.uid,{ inst, cells:new Map(), killed:false });
    const row=rows.get(inst.uid); row.cells.set(frame.cycle,{stage,hold:(stage==='F'&&frame.F_stall)||(stage==='D'&&frame.D_stall)});
    if(frame.mispredict&&(stage==='D'||stage==='F')) row.killed=true;
  }
  $('state-content').innerHTML = `<div class="timing-scroll" id="timing-scroll"><table class="timing-table"><thead><tr><th class="inst-col">PC · 指令</th>${frames.map(f=>`<th>${f.cycle}</th>`).join('')}</tr></thead><tbody>${[...rows].sort((a,b)=>a[0]-b[0]).map(([,row])=>`<tr><th class="inst-col ${row.killed?'squashed':''}" title="${escape(row.inst.text)}${row.killed?' · 预测失败清空':''}">${hex(row.inst.pc,3)} ${escape(row.inst.text)}</th>${frames.map(f=>{const cell=row.cells.get(f.cycle);return cell?`<td style="--stage:${COLORS[cell.stage]}" title="周期 ${f.cycle} · ${cell.stage}${cell.hold?' 保持':''}">${cell.stage}${cell.hold?'·':''}</td>`:'<td class="blank"></td>';}).join('')}</tr>`).join('')}</tbody></table></div><p class="timing-note">F· / D· = 暂停保持；划线 = 预测失败清空。每行代表一条动态指令，循环中的同一地址会重复出现。空泡没有指令身份，见上方 BUBBLE 标记和事件记录。</p>`;
  const scroll=$('timing-scroll'); if(running) scroll.scrollLeft=scroll.scrollWidth;
}

function renderMemory(s) {
  const options = [...program.labels].map(([label,address])=>`<option value="${address}">${escape(label)} · ${hex(address)}</option>`).join('');
  const end = Math.min(memoryStart + 16*8, MEMORY_SIZE);
  let body='';
  for(let address=memoryStart;address<end;address+=8) {
    const value=readWord(simulator.memory,BigInt(address));
    const bytes=[...simulator.memory.slice(address,address+8)].map(b=>b.toString(16).padStart(2,'0')).join(' ');
    const changed=simulator.changedMemory.some(p=>p>=address&&p<address+8), names=[...program.labels].filter(([,p])=>p===address).map(([n])=>n).join(', ');
    body+=`<tr class="${changed?'changed':''}"><td>${hex(address,4)} ${names?`<span class="muted-cell">${escape(names)}</span>`:''}</td><td>${escape(valueText(value))}</td><td class="muted-cell">${bytes}</td></tr>`;
  }
  $('state-content').innerHTML=`<div class="memory-tools"><label for="memory-address">起始地址</label><input id="memory-address" value="${hex(memoryStart)}" aria-label="内存起始地址"><button class="mini-button" id="memory-go">跳转</button><button class="mini-button" id="memory-prev" ${memoryStart===0?'disabled':''}>−128</button><button class="mini-button" id="memory-next" ${memoryStart>=MEMORY_SIZE-128?'disabled':''}>+128</button><button class="mini-button" id="memory-stack">%rsp</button>${options?`<label class="sr-only" for="memory-label">跳转到标签</label><select id="memory-label" style="max-width:140px;font-size:10px;border:1px solid #e0e8ec;padding:4px"><option value="">标签…</option>${options}</select>`:''}</div><div style="overflow-x:auto"><table class="data-table"><thead><tr><th>地址</th><th>64-bit VALUE</th><th>字节 · 小端序</th></tr></thead><tbody>${body}</tbody></table></div><p class="timing-note">统一的 64 KiB 字节内存，代码与数据共享地址空间。${s.memoryRead||s.memoryWrite?`当前访存地址 ${hex(s.memoryAddress)}`:'可通过 .pos / .quad 设置初始数据。'}</p>`;
}

function selectTab(tab) {
  currentTab=tab;
  document.querySelectorAll('[data-tab]').forEach(button=>{const selected=button.dataset.tab===tab;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
  $('state-content').setAttribute('aria-labelledby','tab-'+tab); $('state-content').scrollTop=0;
  renderState(simulator.evaluate());
}

function download() {
  const objectCode=$('file-type').textContent==='.yo';
  const url=URL.createObjectURL(new Blob([source.value],{type:'text/plain;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=(EXAMPLES.find(e=>e.id===$('examples').value)?.id || 'program')+(objectCode?'.yo':'.ys');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

const exampleGroups = [['基础与综合', 0, 7], ['课件：数据转发', 7, 10], ['课件：栈与编码', 10, 14], ['课件：控制与冒险', 14, EXAMPLES.length]];
const exampleOptions = '<option value="custom">自定义程序 / 本地草稿</option>' + exampleGroups.map(([name, start, end])=>`<optgroup label="${name}">${EXAMPLES.slice(start,end).map(e=>`<option value="${e.id}">${escape(e.name)}</option>`).join('')}</optgroup>`).join('');
function syncExample(id) { $('examples').value = id; $('quick-example').value = id; }
function loadExample(id) {
  const next=EXAMPLES.find(e=>e.id===id);
  if(!next) { selectedExample=null;syncExample('custom');setExampleNote(null);return; }
  selectedExample=next; syncExample(next.id); source.value=next.source;source.scrollTop=0;
  lineNumbers();setExampleNote(next);memoryStart=next.id==='sum'?0x180:next.id==='stack'?0x1c0:0x100;compile();
}
for (const id of ['examples', 'quick-example']) { $(id).innerHTML = exampleOptions; $(id).addEventListener('change', event=>loadExample(event.target.value)); }
$('compile').addEventListener('click',compile);$('step').addEventListener('click',step);$('run').addEventListener('click',toggleRun);$('back').addEventListener('click',back);$('reset').addEventListener('click',reset);
$('forwarding-paths').innerHTML = FORWARD_PATHS.map(path=>`<label><input type="checkbox" data-forward="${path}" checked><span>${FORWARD_CONNECTIONS[path].label}</span></label>`).join('');
function applyForwarding(changes) {
  Object.assign(forwardingConfig, changes);
  document.querySelectorAll('[data-forward]').forEach(input=>{input.checked=forwardingConfig[input.dataset.forward];});
  reset(); toast('转发配置已应用，程序已复位。');
}
$('forwarding-paths').addEventListener('change',event=>{const path=event.target.dataset.forward;if(path)applyForwarding({[path]:event.target.checked});});
$('forward-all').addEventListener('click',()=>applyForwarding(Object.fromEntries(FORWARD_PATHS.map(path=>[path,true]))));
$('forward-none').addEventListener('click',()=>applyForwarding(Object.fromEntries(FORWARD_PATHS.map(path=>[path,false]))));
$('signal-select').innerHTML = Object.entries(CONNECTIONS).map(([id,def])=>`<option value="${id}">${escape(def.title)}</option>`).join('');
$('signal-select').value = selectedWire;
$('signal-select').addEventListener('change',event=>{stop(false);selectedWire=event.target.value;render();});
$('isolate-signal').addEventListener('change',()=>{$('datapath').classList.toggle('isolate-signal',$('isolate-signal').checked);});
$('signal-detail').addEventListener('click',event=>{const path=event.target.closest('[data-path]')?.dataset.path;if(path)applyForwarding({[path]:!forwardingConfig[path]});});
function inspectWire(event) {
  const wire = event.target.closest('[data-wire]'); if(!wire)return;
  event.preventDefault();event.stopPropagation();stop(false);selectedWire=wire.dataset.wire;render();
  $('signal-select').focus({preventScroll:true});
  $('signal-inspector').scrollIntoView({block:'nearest',behavior:'smooth'});
}
$('datapath').addEventListener('click',inspectWire);
$('datapath').addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key))inspectWire(event);});
function selectVisualization(view) {
  visualization = view;
  document.querySelectorAll('[data-view]').forEach(button => { const selected = button.dataset.view === view; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
  const url = new URL(window.location.href); if (view === 'timeline') url.searchParams.set('view', 'timeline'); else url.searchParams.delete('view');
  window.history.replaceState(null, '', url);
  if (simulator) render();
}
document.querySelectorAll('[data-view]').forEach(button => {
  button.addEventListener('click', () => selectVisualization(button.dataset.view));
  button.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const view = event.key === 'Home' ? 'datapath' : event.key === 'End' ? 'timeline' : visualization === 'datapath' ? 'timeline' : 'datapath'; selectVisualization(view); $('view-' + view).focus(); });
});
$('cycle-animation').addEventListener('click', event => { if (event.target.closest('.lecture-cell') && !running) step(); });
$('cycle-animation').addEventListener('keydown', event => { if (event.target === $('cycle-animation') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (!running) step(); } });
$('speed').addEventListener('input',()=>{$('speed-label').textContent=$('speed').value+' Hz';});
$('animate').addEventListener('change',()=>{if(!$('animate').checked){clearTimeout(pulseTimer);pulseTimer=null;}$('datapath').classList.toggle('flow',$('animate').checked&&running);$('cycle-animation').classList.toggle('animation-off',!$('animate').checked);});
for (const id of ['timeline-zoom', 'timeline-follow']) $(id).addEventListener('change', render);
function setFocusView(focused) {
  if (focused) focusScroll = window.scrollY;
  document.body.classList.toggle('focus-view', focused);
  $('focus-view').setAttribute('aria-pressed', String(focused));
  $('focus-view').textContent = focused ? '退出专注 ↙' : '专注模式 ⤢';
  render(); window.scrollTo({ top: focused ? 0 : focusScroll, behavior: 'instant' });
}
$('focus-view').addEventListener('click',()=>setFocusView(!document.body.classList.contains('focus-view')));
let lastVisualizationWidth = 0;
new ResizeObserver(entries=>{ const width = Math.round(entries[0].contentRect.width); if (width !== lastVisualizationWidth) { lastVisualizationWidth = width; if (simulator) render(); } }).observe(document.querySelector('.simulator'));
source.addEventListener('input',()=>{dirty=source.value!==compiledSource;stop(false);lineNumbers();saveDraft();selectedExample=null;syncExample('custom');setExampleNote(null);render();});
source.addEventListener('scroll',()=>{$('line-numbers').scrollTop=source.scrollTop;});
source.addEventListener('keydown',event=>{if(event.key==='Tab'){event.preventDefault();const start=source.selectionStart,end=source.selectionEnd;source.setRangeText('    ',start,end,'end');source.dispatchEvent(new Event('input'));}});
$('import-button').addEventListener('click',()=>$('file-input').click());
$('file-input').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;if(file.size>512000){toast('请导入小于 500 KiB 的 .ys 或 .yo 文件。');event.target.value='';return;}try{source.value=await file.text();selectedExample=null;syncExample('custom');setExampleNote(null);lineNumbers();compile();}catch{toast('文件读取失败，请重试。');}event.target.value='';});
$('export-button').addEventListener('click',download);
document.querySelectorAll('[data-tab]').forEach(button=>{button.addEventListener('click',()=>selectTab(button.dataset.tab));button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('[data-tab]')],i=tabs.indexOf(button);const index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;selectTab(tabs[index].dataset.tab);tabs[index].focus();});});
document.querySelectorAll('[data-format]').forEach(button=>button.addEventListener('click',()=>{numberFormat=button.dataset.format;document.querySelectorAll('[data-format]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});renderState(simulator.evaluate());}));
$('state-content').addEventListener('click',event=>{
  const id=event.target.closest('button')?.id;if(!id?.startsWith('memory-'))return;
  try {
    let next=memoryStart;
    if(id==='memory-go') next=Number(BigInt($('memory-address').value.trim()));
    if(id==='memory-prev') next=Math.max(0,memoryStart-128);
    if(id==='memory-next') next=Math.min(MEMORY_SIZE-128,memoryStart+128);
    if(id==='memory-stack') next=Number(simulator.regs[4]);
    if(!Number.isSafeInteger(next)||next<0||next>=MEMORY_SIZE)throw new Error();
    memoryStart=Math.floor(next/8)*8;renderState(simulator.evaluate());
  }catch{toast('内存地址应在 0x0000～0xffff 范围内。');}
});
$('state-content').addEventListener('change',event=>{if(event.target.id==='memory-label'&&event.target.value!==''){memoryStart=Math.min(MEMORY_SIZE-8,Math.floor(Number(event.target.value)/8)*8);renderState(simulator.evaluate());}});
$('state-content').addEventListener('keydown',event=>{if(event.target.id==='memory-address'&&event.key==='Enter')$('memory-go').click();});
$('help-button').addEventListener('click',()=>{stop();$('help-dialog').showModal();});$('close-help').addEventListener('click',()=>$('help-dialog').close());
$('help-dialog').addEventListener('click',event=>{if(event.target===$('help-dialog')){const r=event.target.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)event.target.close();}});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape' && document.body.classList.contains('focus-view') && !$('help-dialog').open) { setFocusView(false); $('focus-view').focus({preventScroll:true}); return; }
  if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();compile();return;}
  if($('help-dialog').open||event.target.closest('textarea,input,select,[role=tab],.lecture-scroll'))return;
  if(event.key==='ArrowRight'){event.preventDefault();if(!running)step();}
  if(event.key==='ArrowLeft'){event.preventDefault();back();}
  if(event.code==='Space'&&!event.target.closest('button,a')){event.preventDefault();toggleRun();}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&running)stop();});
let draft='';try{draft=localStorage.getItem('ics-pipeline-source-v1')||'';}catch{}
source.value=draft||EXAMPLES[0].source;selectedExample=EXAMPLES.find(e=>e.source===source.value)||null;
syncExample(selectedExample?.id||'custom');setExampleNote(selectedExample);lineNumbers();compile();
selectVisualization(visualization);

// Read-only diagnostic view for browser QA and instructional console inspection.
Object.defineProperty(window,'pipelineLab',{get:()=>({cycle:simulator?.cycle,status:simulator?.status,registers:simulator?.regs.map(String),cc:{...simulator?.cc},running,dirty,tab:currentTab})});
