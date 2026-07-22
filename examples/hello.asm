; hello.asm — a DOS program, lovingly typeset by a stylesheet
; assemble:  accsembly examples/hello.asm
; run:       dosbox hello.com

org 256               ; .COM files load at 0x100 (a 256px spacer, literally)

mov ah, 9             ; DOS: print '$'-terminated string at DS:DX
mov dx, msg
int 0x21              ; hex literals: four digit attributes, 64 selectors

mov ax, 0x4c00        ; exit(0)
int 0x21

msg: db "hello from a cascading style sheet!", 13, 10, 36
