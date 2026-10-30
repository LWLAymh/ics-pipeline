// Logical endpoints accompany the geometric routes in app.js. Crossings without
// a dot are independent nets; selected paths expose both endpoint markers.
const net = (title, from, to, rule, width = '64 bit') => ({ title, from, to, rule, width });
export const CONNECTIONS = {
  'pc-prediction': net('预测下一条 PC', 'f_predPC', 'F.predPC → PC 选择器', 'jXX / call 选择 valC；其余选择 valP。F_stall 时保持 F.predPC。'),
  'pc-branch': net('分支纠正', 'M.valA', 'PC 选择器 → f_pc', 'M.icode == IJXX && !M.Cnd。优先级高于 ret 与预测 PC。'),
  'pc-return': net('返回地址', 'W.valM', 'PC 选择器 → f_pc', 'W.icode == IRET，且当前没有 M 级分支纠正。'),
  'pc-output': net('选定取指地址', 'PC 选择器输出 f_pc', 'PC / 指令内存地址', '依次选择 M 级分支纠正、W 级 ret 返回地址、F.predPC。'),
  'pc-imem': net('指令内存地址', 'f_pc', '指令内存地址端口', '用选定的字节地址读取指令。PC 以字节计数。'),
  'pc-increment': net('顺序下一地址', 'f_pc 与指令长度', 'valP 加法器 → f_valP', 'f_valP = f_pc + 指令长度（1 / 2 / 9 / 10 字节）。'),
  'instruction-bus': net('取指结果', '指令内存 / 解码器', 'F/D 流水线寄存器', 'F、D 正常推进时锁存；D_stall 保持，D_bubble 清空。', '指令字段信号束'),
  'decode-bus': net('寄存器编号解码', 'D.rA / D.rB / D.icode', 'srcA / srcB 与寄存器文件', '按指令决定读取哪个寄存器；RNONE 表示不读取。', '寄存器编号各 4 bit'),
  'decode-valp': net('返回 / 顺序地址', 'D.valP', 'd_valA 选择器 → D/E.valA', 'call 与 jXX 直接取 D.valP，覆盖寄存器 / 转发选择。'),
  'decode-valc': net('立即数 / 位移', 'D.valC', 'D/E.valC', 'irmovq / rmmovq / mrmovq / iaddq 保存立即数，供 E 级 ALU 使用。'),
  'register-a': net('读端口 A', '寄存器文件 R[d_srcA]', 'valA 转发选择器', '没有更新的未写回生产者时，使用寄存器文件当前值。'),
  'register-b': net('读端口 B', '寄存器文件 R[d_srcB]', 'valB 转发选择器', '没有更新的未写回生产者时，使用寄存器文件当前值。'),
  'decode-a': net('译码操作数 A', 'valA 选择器输出 d_valA', 'D/E.valA', 'D 正常推进时锁存；数据等待时保持 D，在 E 注入气泡。'),
  'decode-b': net('译码操作数 B', 'valB 选择器输出 d_valB', 'D/E.valB', '按最新生产者选择转发或寄存器值；不可用时暂停。'),
  'alu-a-register': net('ALU A：寄存器值', 'E.valA', 'ALU A 选择器', 'rrmovq / cmovXX / OPq 使用 E.valA。'),
  'alu-a-immediate': net('ALU A：立即数', 'E.valC', 'ALU A 选择器', 'irmovq / rmmovq / mrmovq / iaddq 使用 E.valC。'),
  'alu-a': net('ALU 输入 A', 'ALU A 选择器', 'ALU.A', '选 E.valA、E.valC、-8（压栈）或 +8（出栈）。'),
  'alu-b-register': net('ALU B：基址 / 累加值', 'E.valB', 'ALU B 选择器', '算术、地址计算及栈操作使用 E.valB。'),
  'alu-b': net('ALU 输入 B', 'ALU B 选择器', 'ALU.B', 'irmovq / rrmovq / cmovXX 选 0；其余需要累加 / 基址时选 E.valB。'),
  'alu-result': net('ALU 结果', 'ALU 输出 e_valE', 'E/M.valE 与 E 级转发支路', 'OPq 执行指定 ALU 运算；地址、传送、iaddq 执行加法。'),
  'execute-pass-a': net('跨执行级传递 valA', 'E.valA', 'E/M.valA', '保存写内存数据、栈读地址、call 返回地址或分支纠正地址。'),
  'condition-test': net('条件判断输入', '条件码 ZF / SF / OF', '条件判断器', '依据 E.ifun 判断分支 / 条件移动；有符号小于使用 SF XOR OF。', 'ZF / SF / OF 各 1 bit'),
  'condition-out': net('分支判断结果', '条件判断 e_Cnd', 'E/M.Cnd', '条件不成立的分支在 E 注入 D、E 气泡，下一周期从 M.valA 纠正 PC。', '1 bit'),
  'memory-address': net('访存地址：ALU', 'M.valE', '数据内存地址端口', 'mrmovq / rmmovq / pushq / call 使用 ALU 计算的地址。'),
  'memory-stack-address': net('访存地址：旧栈顶', 'M.valA', '数据内存地址端口', 'popq / ret 从旧 %rsp 读取；M.valE 是更新后的栈指针。'),
  'memory-write-data': net('写入内存的数据', 'M.valA', '数据内存写数据端口', 'rmmovq / pushq 写寄存器值，call 写 valP；8 字节小端序。'),
  'memory-read': net('内存读结果', '数据内存输出 m_valM', 'M/W.valM 与 M.valM 转发支路', 'mrmovq / popq / ret 读取；读结果在 M 级组合逻辑结束时可用。'),
  'memory-pass': net('跨访存级传递 valE', 'M.valE', 'M/W.valE 与 M.valE 转发支路', 'ALU 结果直接跨过访存级；这不是内存读取的数据。'),
  'wb-e-input': net('写回值 E', 'W.valE', '寄存器文件写端口 E', 'W.stat == AOK && W.dstE != RNONE。'),
  'wb-m-input': net('写回值 M', 'W.valM', '寄存器文件写端口 M', 'W.stat == AOK && W.dstM != RNONE。'),
  'wb-e': net('寄存器写回 E', '写回端口 E：W.valE / W.dstE', '寄存器文件', '时钟边沿写 R[W.dstE]；与端口 M 目标相同时，M 优先。'),
  'wb-m': net('寄存器写回 M', '写回端口 M：W.valM / W.dstM', '寄存器文件', '时钟边沿写 R[W.dstM]。popq %rsp 时加载值覆盖栈指针增量。'),
};

export const FORWARD_CONNECTIONS = {
  E_valE: { wire: 'forward-e', label: 'E.valE → D', source: 'ALU 输出 e_valE', destination: 'e_dstE', value: 'e_valE', stage: 'E' },
  M_valM: { wire: 'forward-m', label: 'M.valM → D', source: '数据内存输出 m_valM', destination: 'M.dstM', value: 'm_valM', stage: 'M' },
  M_valE: { wire: 'forward-m-e', label: 'M.valE → D', source: 'E/M.valE', destination: 'M.dstE', value: 'M.valE', stage: 'M' },
  W_valM: { wire: 'forward-w-m', label: 'W.valM → D', source: 'M/W.valM', destination: 'W.dstM', value: 'W.valM', stage: 'W' },
  W_valE: { wire: 'forward-w-e', label: 'W.valE → D', source: 'M/W.valE', destination: 'W.dstE', value: 'W.valE', stage: 'W' },
};
for (const [path, def] of Object.entries(FORWARD_CONNECTIONS)) CONNECTIONS[def.wire] = {
  ...net(def.label, def.source, '译码级 valA / valB 转发选择器', `${def.destination} 匹配 d_srcA / d_srcB，且它是最新生产者、该路径已开启。优先级：E.valE → M.valM → M.valE → W.valM → W.valE → 寄存器文件。`), path,
};

export function forwardingState(path, simulator, signals) {
  const def = FORWARD_CONNECTIONS[path];
  const dst = path === 'E_valE' ? signals.e_dstE : simulator[def.stage][def.destination.split('.')[1]];
  const value = def.value.includes('.') ? simulator[def.stage][def.value.split('.')[1]] : signals[def.value];
  const users = signals.forwards.filter(forward => forward.path === path);
  const live = simulator.status === 'AOK' && simulator.D.stat === 'AOK';
  return { dst, value, users, state: !simulator.forwarding[path] ? '已关闭' : !live || simulator[def.stage].stat !== 'AOK' ? '无有效指令' : users.length ? (signals.E_bubble ? '已选中 · 本周期不锁存' : '正在转发') : '未选中' };
}
