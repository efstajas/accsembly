; boot.asm — a BIOS boot sector, assembled by a cascading style sheet
;
; assemble:  accsembly examples/boot.asm -o boot.img
; run:       qemu-system-i386 -drive format=raw,file=boot.img
;
; No DOS here: the BIOS loads this sector at 0x7C00 and jumps in.

org 31744             ; 0x7C00 — a thirty-one-thousand-pixel org spacer

xor ax, ax
mov ds, ax            ; flat little world
cld

mov si, msg
next:
lodsb                 ; al = *si++
cmp al, 0
je halt
mov ah, 0x0e          ; BIOS teletype
int 0x10
jmp next

halt:
hlt
jmp halt

msg: db "A cascading style sheet booted this computer.", 13, 10, 0

pad 510               ; flexbox fills the sector with zeros
dw 0xaa55             ; the BIOS handshake
