; nasm twin of examples/boot.asm, used by test/differential.js to prove the
; stylesheet's boot sector is byte-identical to nasm's
bits 16
org 31744

xor ax, ax
mov ds, ax
cld

mov si, msg
next:
lodsb
cmp al, 0
je halt
mov ah, 0x0e
int 0x10
jmp short next

halt:
hlt
jmp short halt

msg: db "A cascading style sheet booted this computer.", 13, 10, 0

times 510-($-$$) db 0
dw 0xaa55
