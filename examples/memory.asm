; memory.asm — pointers, in a stylesheet
; walks a string byte-by-byte through [bx] instead of asking DOS to do it

org 256

mov bx, msg
next:
mov dx, 0
mov dl, [bx]          ; load the character bx points at   (8a 97 00 00)
cmp dx, '$'           ; terminator?
je done
mov ah, 2             ; DOS: print char in DL
int 0x21
inc bx
jmp next

done:
mov ax, 0x4c00        ; exit(0)
int 0x21

msg: db "memory operands, in CSS$"
