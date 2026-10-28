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
  }
];
