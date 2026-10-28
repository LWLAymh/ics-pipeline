import { decode, hex, regName } from './core.js';

const ORDER = ['F', 'D', 'E', 'M', 'W'];
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** A current-cycle view, including completed trace columns and the live stages.
 * Unlike a precomputed schedule, this follows actual stalls, speculation and loops.
 */
export function buildTimeline(program, simulator) {
  const signals = simulator.evaluate();
  const cycle = simulator.cycle + 1;
  const terminal = simulator.status !== 'AOK';
  const current = {
    cycle,
    stages: {
      F: terminal ? null : { ...signals.fetched, uid: simulator.nextUid },
      D: simulator.D, E: simulator.E, M: simulator.M, W: simulator.W,
    },
    loadUse: !terminal && signals.loadUse,
    ret: !terminal && signals.ret,
    mispredict: !terminal && signals.mispredict,
    D_bubble: !terminal && signals.D_bubble,
  };
  const frames = [...simulator.trace.slice(-39), current];
  const firstCycle = frames[0].cycle;
  const frameAt = new Map(frames.map(frame => [frame.cycle, frame]));
  const rows = new Map(), observedPCs = new Set();
  const objectCode = /^\s*0x[\da-f]+\s*:/im.test(program.source);
  const label = inst => {
    const original = program.listing.get(Number(inst.pc));
    // Preserve readable source syntax only when it still matches the fetched bytes.
    const unchanged = original && !objectCode && !original.isData && original.bytes.every((byte, i) => simulator.memory[Number(inst.pc) + i] === byte);
    return `${hex(inst.pc, 3)}: ${unchanged ? original.text : inst.text}`;
  };
  const visible = inst => inst?.uid && inst.stat !== 'BUB' && !(inst.stat === 'HLT' && !program.used.has(Number(inst.pc)));

  for (const frame of frames) {
    for (const [stage, inst] of Object.entries(frame.stages)) {
      if (!visible(inst) || (stage === 'F' && frame.ret && !frame.loadUse)) continue;
      observedPCs.add(Number(inst.pc));
      if (!rows.has(inst.uid)) rows.set(inst.uid, { id: inst.uid, order: inst.uid, label: label(inst), cells: [], canceled: false, bubble: false });
      const row = rows.get(inst.uid);
      const previous = frameAt.get(frame.cycle - 1)?.stages[stage];
      const stalled = ['F', 'D'].includes(stage) && previous?.uid === inst.uid;
      row.cells.push({ cycle: frame.cycle, stage, stalled });
      if (frame.mispredict && frame.cycle < cycle && ['F', 'D'].includes(stage)) row.canceled = true;
    }
  }

  // Give injected bubbles identities so their E/M/W movement can be followed.
  // Initial empty pipeline stages are intentionally not shown as bubble rows.
  for (const frame of frames) {
    if (frame.cycle >= cycle) continue;
    for (const startStage of ['D', 'E']) {
      if (!(startStage === 'D' ? frame.D_bubble : frame.loadUse || frame.mispredict)) continue;
      const target = startStage === 'E' ? frame.stages.D : frame.stages.F;
      const retStage = ['M', 'E', 'D'].find(stage => frame.stages[stage]?.icode === 9 && frame.stages[stage].stat === 'AOK');
      const retInstruction = frame.stages[retStage];
      const order = frame.ret && startStage === 'D' ? (retInstruction?.uid || target?.uid || 0) + .1 + .01 * ORDER.indexOf(retStage) : (target?.uid || 0) + (frame.loadUse ? -.1 : .1);
      const row = { id: `bubble-${startStage}-${frame.cycle}`, order, label: 'bubble', cells: [], canceled: false, bubble: true };
      const start = ORDER.indexOf(startStage);
      if (startStage === 'D' && frame.ret && !frame.loadUse) row.cells.push({ cycle: frame.cycle, stage: '停', stalled: true });
      for (let index = start; index < ORDER.length; index++) {
        const at = frame.cycle + 1 + index - start;
        if (at > cycle) break;
        if (frameAt.get(at)?.stages[ORDER[index]]?.stat !== 'BUB') break;
        row.cells.push({ cycle: at, stage: ORDER[index], stalled: false });
      }
      if (row.cells.length) rows.set(row.id, row);
    }
  }

  // Unfetched instructions stay visible as empty rows, like the lecture slides.
  for (const entry of program.listing.values()) {
    if (entry.isData || observedPCs.has(Number(entry.pc))) continue;
    if (simulator.trace.some(frame => Object.values(frame.stages).some(inst => inst.uid && inst.stat !== 'BUB' && inst.pc === entry.pc))) continue;
    const inst = decode(program.memory, entry.pc);
    rows.set(`pending-${entry.pc}`, { id: `pending-${entry.pc}`, order: Infinity, label: label(inst), cells: [], canceled: false, bubble: false });
    if (rows.size >= 120) break;
  }
  const ordered = [...rows.values()].sort((a, b) => a.order - b.order).slice(-120);
  const known = new Set(ordered.map(row => row.id));
  const forwards = terminal || signals.E_bubble ? [] : signals.forwards.map(forward => ({
    ...forward, from: simulator[forward.from[0]].uid, to: simulator.D.uid,
  })).filter(forward => known.has(forward.from) && known.has(forward.to));
  return { cycle, firstCycle, endCycle: cycle + 2, rows: ordered, forwards, terminal };
}

/** Open a lane at the stall itself, leaving earlier cells in their original lanes. */
export function layoutTimelineRows(rows, cycle) {
  const split = rows.some(row => row.cells.some(cell => cell.stalled));
  const lane = (index, at) => index - (split ? rows.slice(0, index).filter(row => row.bubble && row.cells[0].cycle > at).length : 0);
  return rows.map((row, index) => {
    const cells = row.cells.map(cell => ({ ...cell, lane: lane(index, cell.cycle) }));
    const turns = cells.flatMap((cell, offset) => {
      const previous = cells[offset - 1];
      return previous && previous.lane !== cell.lane ? [{ previous, cell }] : [];
    });
    return { ...row, lane: lane(index, cycle), cells, turns };
  });
}

/** Keep the highlight group mounted between edges for a smooth column slide. */
export function renderTimeline(host, model, animate = true) {
  const gridX = 375, gridY = 54, columnWidth = 54, rowHeight = 39;
  const width = gridX + (model.endCycle - model.firstCycle + 1) * columnWidth + 16;
  const height = gridY + Math.max(model.rows.length, 5) * rowHeight + 17;
  const x = cycle => gridX + (cycle - model.firstCycle) * columnWidth;
  const y = index => gridY + index * rowHeight;
  const rows = layoutTimelineRows(model.rows, model.cycle);
  const rowIndex = new Map(rows.map(row => [row.id, row.lane]));
  if (!host.querySelector('.lecture-scroll')) {
    host.innerHTML = `<div class="lecture-topline"><span class="lecture-kicker">指令 × 周期</span><span class="lecture-current"></span></div><div class="lecture-scroll"><svg class="lecture-svg" role="img" aria-label="逐周期流水线动画"><title>单击图表推进一个周期</title><defs><marker id="timeline-arrowhead" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6" fill="none" stroke="#0f766e" stroke-width="1.5"/></marker></defs><rect class="lecture-background" width="100%" height="100%" rx="7"/><g class="lecture-grid"></g><g class="lecture-highlight"><rect x="0" y="7" width="${columnWidth}" rx="5"/></g><g class="lecture-forwards"></g></svg></div><div class="lecture-legend"><span><i class="lecture-swatch"></i>已执行</span><span><i class="lecture-swatch current"></i>当前周期</span><span><i class="lecture-swatch bubble"></i>气泡</span><span class="lecture-held">D̲ 暂停</span><span class="lecture-canceled">清空</span><span class="lecture-forward-key">↳ 转发</span></div>`;
  }
  host.classList.toggle('animation-off', !animate);
  host.querySelector('.lecture-current').textContent = `第 ${model.cycle} 周期${model.terminal ? ' · 已停止' : ''}`;
  const svg = host.querySelector('svg');
  const canvasWidth = Math.max(width, host.querySelector('.lecture-scroll').clientWidth);
  svg.setAttribute('viewBox', `0 0 ${canvasWidth} ${height}`);
  svg.style.width = `${canvasWidth}px`;
  svg.style.height = `${height}px`;
  svg.setAttribute('aria-label', `指令与周期动画，第 ${model.cycle} 周期`);
  let markup = `<text x="15" y="33" class="lecture-axis">指令 / 周期</text>`;
  for (let cycle = model.firstCycle; cycle <= model.endCycle; cycle++) markup += `<text x="${x(cycle) + columnWidth / 2}" y="34" text-anchor="middle" class="lecture-cycle ${cycle === model.cycle ? 'selected' : cycle > model.cycle ? 'future' : ''}">${cycle}</text>`;
  rows.forEach(row => {
    const display = row.label.length > 37 ? row.label.slice(0, 35) + '…' : row.label;
    markup += `<g class="lecture-row ${row.canceled ? 'canceled' : ''} ${row.bubble ? 'bubble' : ''}" data-instruction="${escape(row.id)}"><title>${escape(row.label)}</title><text x="14" y="${y(row.lane) + 26}" class="lecture-instruction">${escape(display)}</text>`;
    for (const cell of row.cells) {
      if (cell.cycle < model.firstCycle) continue;
      markup += `<g class="lecture-cell ${row.bubble ? 'bubble' : ''} ${cell.stalled ? 'held' : ''} ${cell.cycle === model.cycle ? 'current' : ''}" data-cycle="${cell.cycle}" data-stage="${cell.stage}" data-lane="${cell.lane}"><title>${escape(row.label)} · 第 ${cell.cycle} 周期 · ${cell.stage}${cell.stalled ? ' 保持' : ''}</title><rect x="${x(cell.cycle)}" y="${y(cell.lane)}" width="${columnWidth}" height="${rowHeight}"/><text x="${x(cell.cycle) + columnWidth / 2}" y="${y(cell.lane) + 27}" text-anchor="middle">${cell.stage}</text>${cell.stalled ? `<path d="M${x(cell.cycle) + 12} ${y(cell.lane) + 33} h${columnWidth - 24}"/>` : ''}</g>`;
    }
    markup += '</g>';
  });
  for (const row of rows) for (const turn of row.turns) {
    const boundary = x(turn.cell.cycle);
    markup += `<path class="lecture-stall-turn" data-instruction="${escape(row.id)}" data-cycle="${turn.cell.cycle}" d="M${boundary - 7} ${y(turn.previous.lane) + rowHeight / 2} H${boundary} V${y(turn.cell.lane) + rowHeight / 2} h7"/>`;
  }
  host.querySelector('.lecture-grid').innerHTML = markup;
  const highlight = host.querySelector('.lecture-highlight');
  highlight.style.transform = `translateX(${x(model.cycle)}px)`;
  highlight.querySelector('rect').setAttribute('height', String(height - 14));
  host.querySelector('.lecture-forwards').innerHTML = model.forwards.map((forward, index) => {
    const from = rowIndex.get(forward.from), to = rowIndex.get(forward.to), arrowX = x(model.cycle) + columnWidth - 5 - index * 8;
    return `<path d="M${arrowX} ${y(from) + 11} V${y(to) + rowHeight - 10}" marker-end="url(#timeline-arrowhead)"><title>${escape('val' + forward.port + ': ' + regName(forward.reg) + ' = ' + hex(forward.value))}</title></path>`;
  }).join('');
  const scroller = host.querySelector('.lecture-scroll'), target = x(model.cycle);
  if (target + columnWidth > scroller.scrollLeft + scroller.clientWidth - 10 || target < scroller.scrollLeft) {
    scroller.scrollLeft = Math.max(0, target + columnWidth - scroller.clientWidth + 25);
  }
  host.dataset.cycle = String(model.cycle);
}
