; countdown.asm — loops, labels, and backward jumps resolved by the cascade
; prints "5 4 3 2 1 liftoff!"

org 256

mov cx, 5
top:
mov dx, cx
add dx, '0'           ; char literals work too
mov ah, 2             ; DOS: print char in DL
int 0x21
mov dl, ' '
int 0x21
loop top              ; the E2 rel8 you are about to enjoy was computed by mod()

mov dx, msg
mov ah, 9
int 0x21
mov ax, 0x4c00
int 0x21

msg: db "liftoff!", 13, 10, 36
