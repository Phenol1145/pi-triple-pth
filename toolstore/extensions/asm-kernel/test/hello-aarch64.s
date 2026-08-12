// aarch64 hello（生产核冒烟——纯 syscall 无 libc；as→ld→run host 直跑）
.global _start
.text
_start:
    mov x0, #1            // fd = stdout
    adr x1, msg
    mov x2, #11           // len ("hello asm!\n" = 11)
    mov x8, #64           // write
    svc #0
    mov x0, #0            // exit code
    mov x8, #93           // exit
    svc #0
.data
msg: .ascii "hello asm!\n"
