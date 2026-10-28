export const EXAMPLES = [
  {
    id: 'forward', name: '01 · 数据转发', title: '结果还没写回，下一条指令就要用',
    description: '单步观察 E → D 转发：addq 和 subq 无需等待寄存器写回。最终 %rax = 10，%rbx = 22，%rcx = 12。',
    source: `# 数据依赖不一定需要暂停：先看转发连线\n.pos 0\n    irmovq $10, %rax\n    irmovq $12, %rbx\n    addq %rax, %rbx\n    rrmovq %rbx, %rcx\n    subq %rax, %rcx\n    halt\n`
  },
  {
    id: 'load', name: '02 · Load / use 冒险', title: '访存的结果，要再等一个周期',
    description: 'mrmovq 后立即使用 %rax：F、D 暂停，E 插入一个气泡，随后从 M 转发数据。最终 %rax = 21，%rbx = 42。',
    source: `# 观察 load/use 触发的一个暂停周期\n.pos 0\n    irmovq data, %rdi\n    mrmovq 0(%rdi), %rax\n    addq %rax, %rbx\n    addq %rax, %rbx\n    halt\n\n.pos 0x100\ndata:\n    .quad 21\n`
  },
  {
    id: 'branch', name: '03 · 分支预测失败', title: '默认预测跳转，猜错就清空两级',
    description: 'jne 被预测为跳转，但 ZF = 1，实际不跳转。观察 D、E 气泡和 PC 纠正；错误路径的 99 不会写回。最终 %rbx = 7。',
    source: `# Y86 PIPE 对 jXX 采用“预测跳转”\n.pos 0\n    irmovq $1, %rax\n    subq %rax, %rax\n    jne wrong\n    irmovq $7, %rbx\n    halt\nwrong:\n    irmovq $99, %rbx\n    irmovq $88, %rcx\n    halt\n`
  },
  {
    id: 'stack', name: '04 · Call / ret 与栈', title: '返回地址怎样从栈回到 PC',
    description: 'call 把返回地址压栈；ret 需要等到 W 才能确定下一条指令。观察 %rsp 的变化和返回地址连线。最终 %rax = 42，%rsp = 0x200。',
    source: `# call / ret / pushq / popq\n.pos 0\n    irmovq stack, %rsp\n    irmovq $21, %rax\n    call twice\n    halt\ntwice:\n    pushq %rbx\n    rrmovq %rax, %rbx\n    addq %rbx, %rax\n    popq %rbx\n    ret\n\n.pos 0x200\nstack:\n`
  },
  {
    id: 'sum', name: '05 · 数组求和', title: '把数据冒险、循环和返回连起来看',
    description: '经典数组求和：4 个元素的和为 100。包含 load/use、预测成功的循环分支，以及退出循环时的一次预测失败。',
    source: `# sum(array, 4) → %rax = 100\n.pos 0\n    irmovq stack, %rsp\n    call main\n    halt\nmain:\n    irmovq array, %rdi\n    irmovq $4, %rsi\n    call sum\n    ret\nsum:\n    irmovq $8, %r8\n    irmovq $1, %r9\n    xorq %rax, %rax\n    jmp test\nloop:\n    mrmovq 0(%rdi), %r10\n    addq %r10, %rax\n    addq %r8, %rdi\n    subq %r9, %rsi\ntest:\n    andq %rsi, %rsi\n    jne loop\n    ret\n\n.pos 0x180\narray:\n    .quad 10, 20, 30, 40\n.pos 0x400\nstack:\n`
  },
  {
    id: 'conditional', name: '06 · 条件移动与溢出', title: '条件码决定写回是否发生',
    description: '最大有符号整数加 1 发生溢出：SF = OF = 1，所以有符号比较并不认为结果小于 0。cmovl 不执行，cmovge 执行。',
    source: `# 条件移动使用 SF、ZF、OF\n.pos 0\n    irmovq $0x7fffffffffffffff, %rax\n    irmovq $1, %rbx\n    irmovq $42, %rdi\n    addq %rbx, %rax\n    cmovl %rdi, %rcx\n    cmovge %rdi, %rdx\n    halt\n`
  },
  {
    id: 'lecture', name: '07 · 课件中的存储 / 加载', title: '03-Arch · 存储、加载与暂停',
    description: '与课件方格动画相同的指令序列。最终 M[128] = 3，%rax = 13。',
    source: `# 03-Arch：先存储，再加载\n.pos 0\n    irmovq $128, %rdx\n    irmovq $3, %rcx\n    rmmovq %rcx, 0(%rdx)\n    irmovq $10, %rbx\n    mrmovq 0(%rdx), %rax\n    addq %rbx, %rax\n    halt\n`
  },
  {
    id: 'slides-adjacent', name: '08 · 课件：相邻指令两路转发', title: '相邻指令：M → D 与 E → D',
    description: '来自 pipelineScenarios.ts 的 forwarding。addq 在同一周期接收 10 和 3；最终 %rdx = 10，%rax = 13，无需暂停。',
    source: `# 课件：pipelineScenarios.ts / forwarding
.pos 0
    irmovq $10, %rdx
    irmovq $3, %rax
    addq %rdx, %rax
    halt
`
  },
  {
    id: 'slides-gap', name: '09 · 课件：隔一条 nop 的转发', title: '间隔一条 nop：W → D 与 M → D',
    description: '来自 pipelineScenarios.ts 的 forwardingGap。与示例 08 对比转发源的位置；最终 %rax = 13。',
    source: `# 课件：pipelineScenarios.ts / forwardingGap
.pos 0
    irmovq $10, %rdx
    irmovq $3, %rax
    nop
    addq %rdx, %rax
    halt
`
  },
  {
    id: 'slides-two-nops', name: '10 · 课件：两条 nop 与写回转发', title: '生产者在 W，消费者在 D',
    description: '取自课件 raw / stall 的指令序列，在本站带转发的 PIPE 上执行。观察第二条 irmovq 从 W 向 D 转发；最终 %rax = 13。',
    source: `# 课件：pipelineScenarios.ts / raw、stall 的指令序列
# 本站 PIPE 开启数据转发，因此这组指令可以直接正确执行。
.pos 0
    irmovq $10, %rdx
    irmovq $3, %rax
    nop
    nop
    addq %rdx, %rax
    halt
`
  },
  {
    id: 'slides-push-rsp', name: '11 · 课件：pushq %rsp 压入哪个值', title: 'pushq %rsp 压入旧栈指针',
    description: '改编自 03-Arch 中的 pushq %rsp 问题，补齐初始化和弹栈。最终 %rax = 0x200，%rsp = 0x200；M[0x1f8] 保存 0x200。',
    source: `# 课件：03-Arch / pushq %rsp 的语义
# 补齐栈初始化及 popq，以便直接运行并检查压入的值。
.pos 0
    irmovq $0x200, %rsp
    pushq %rsp
    popq %rax
    halt
`
  },
  {
    id: 'slides-pop-rsp', name: '12 · 课件：popq %rsp 的写回优先级', title: '同一寄存器同时收到 valE 与 valM',
    description: '改编自 03-Arch 的 popq %rsp 问题。弹出的值覆盖栈指针递增结果；最终 %rsp = %rbx = 0x300。紧接着读取 %rsp 会触发 load/use。',
    source: `# 课件：03-Arch / popq %rsp 的语义
# 为栈顶准备 0x300，观察 valM 写回优先于 valE。
.pos 0
    irmovq $0x200, %rsp
    irmovq $0x300, %rax
    pushq %rax
    popq %rsp
    rrmovq %rsp, %rbx
    halt
`
  },
  {
    id: 'slides-encoding-call', name: '13 · 课件：0x200 处的调用与返回', title: '机器码翻译题中的 pushq / call / ret',
    description: '改编自 03-Arch「汇编与机器码翻译」题，保留 0x200、0x20c 的布局，补齐入口和栈。最终 %rbx = 10；返回地址 0x20b 位于 M[0x7f0]。',
    source: `# 课件：03-Arch / 汇编与机器码翻译题
# 原片段位于 0x200；补齐 PC=0 的入口和合法栈。
.pos 0
    irmovq $0x800, %rsp
    jmp main

.pos 0x200
main:
    pushq %rbp
    call proc
    halt

.pos 0x20c
proc:
    irmovq $10, %rbx
    ret
`
  },
  {
    id: 'slides-negative-offset', name: '14 · 课件：负位移与小端存储', title: 'rmmovq %rcx, -3(%rbx)',
    description: '改编自 03-Arch 的编码练习，补齐数据和读回操作。0x103 − 3 = 0x100；最终 %rax = 0x1122334455667788，内存视图可见小端字节顺序。',
    source: `# 课件：03-Arch / rmmovq %rcx, -3(%rbx) 编码练习
# 补齐寄存器初始化与读回，查看内存 0x100 的小端字节。
.pos 0
    irmovq $0x103, %rbx
    irmovq $0x1122334455667788, %rcx
    rmmovq %rcx, -3(%rbx)
    mrmovq -3(%rbx), %rax
    halt
`
  },
  {
    id: 'slides-combination-a', name: '15 · 课件：预测失败 + ret（组合 A）', title: '错误路径的 ret 也要被清空',
    description: '按 03-Arch「特殊控制条件：组合 A」构造完整程序。jne 在 E 发现预测错误，同时错误路径的 ret 在 D；最终执行顺序路径，%rax = 1，%rsp = 0x200。',
    source: `# 课件：03-Arch / 特殊控制条件，组合 A
# 根据课件条件构造：E 中预测失败的 JXX，D 中为 RET。
.pos 0
    irmovq $0x200, %rsp
    xorq %rax, %rax
    jne wrong_return
    irmovq $1, %rax
    halt
wrong_return:
    ret
`
  },
  {
    id: 'slides-combination-b', name: '16 · 课件：加载 %rsp + ret（组合 B）', title: 'load/use 与 ret 同时出现时，优先保持 D',
    description: '按 03-Arch「特殊控制条件：组合 B」构造完整程序。mrmovq 加载新的 %rsp，紧随其后的 ret 必须等待；最终 %rax = 42，%rsp = 0x208。',
    source: `# 课件：03-Arch / 特殊控制条件，组合 B
# 根据课件条件构造：加载指令设置 %rsp，RET 立即使用。
.pos 0
    irmovq $0x100, %rdi
    mrmovq 0(%rdi), %rsp
    ret
    halt
returned:
    irmovq $42, %rax
    halt

.pos 0x100
    .quad 0x200
.pos 0x200
    .quad returned
`
  },
  {
    id: 'slides-load-nop', name: '17 · 课件扩展：加载后插入 nop', title: '与示例 07 对比：用 nop 填入等待周期',
    description: '扩展自课件 loadStall，在 mrmovq 和 addq 之间放一条 nop。最终仍为 %rax = 13；load/use 暂停消失，但 nop 自身也占一个周期。',
    source: `# 课件扩展：pipelineScenarios.ts / loadStall
# 与示例 07 相比，只在加载之后插入一条 nop。
.pos 0
    irmovq $128, %rdx
    irmovq $3, %rcx
    rmmovq %rcx, 0(%rdx)
    irmovq $10, %rbx
    mrmovq 0(%rdx), %rax
    nop
    addq %rbx, %rax
    halt
`
  },
  {
    id: 'slides-repeated-load', name: '18 · 课件扩展：连续三次 load/use', title: '观察三次独立的暂停与局部折行',
    description: '扩展自课件加载 / 使用案例，分别加载 3、4、5 并累加。最终 %rbx = 12，%rax = 5；应出现三次 load/use 暂停。',
    source: `# 课件扩展：03-Arch / 加载与使用冒险
# 三组相邻的 load/use，观察三次暂停、气泡与折行。
.pos 0
    irmovq values, %rdi
    mrmovq 0(%rdi), %rax
    addq %rax, %rbx
    mrmovq 8(%rdi), %rax
    addq %rax, %rbx
    mrmovq 16(%rdi), %rax
    addq %rax, %rbx
    halt
.pos 0x100
values:
    .quad 3, 4, 5
`
  },
  {
    id: 'slides-cmov-forward', name: '19 · 课件扩展：条件移动与转发', title: 'cmov 不成立时，e_dstE 变为 RNONE',
    description: '依据 03-Arch「为什么使用 e_dstE 而不是 E_dstE」构造。cmovne 不写回也不转发，cmove 正常转发；最终 %rdx = 5，%rbx = %rsi = 9。',
    source: `# 课件扩展：03-Arch / 条件移动与 e_dstE
# 对比不成立和成立的 cmov，紧跟消费者观察转发。
.pos 0
    irmovq $5, %rbx
    irmovq $9, %rcx
    xorq %rax, %rax
    cmovne %rcx, %rbx
    rrmovq %rbx, %rdx
    cmove %rcx, %rbx
    rrmovq %rbx, %rsi
    halt
`
  }
];
