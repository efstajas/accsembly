; boot/writer.asm — the readout stage of the bootstrapped accsembly chain.
; Turns measured element widths back into bytes. This program is itself
; assembled by assembler.css and executed by the 8086 interpreter.
;
; input, appended to this binary at inp:
;   u16 rowcount, u16 orgn, u16 padn
;   per row: u16 lineno, u8 kind, u16 x, u16 w, u16 m, then m * u16 widths
;   kind: 0 op, 1 db, 2 dw, 3 lbl, 4 org, 5 pad
; output (int 0x21 ah=2, captured by the harness):
;   0x02 u16 count, count bytes    one frame per row
;   0x03 u16 lineno, u8 code       fatal error, stop
;     code 1 garbage width  2 no encoding  3 pad overrun  4 cell refused
;   0x04                           done
	org 256
	jmp main

rows:	dw 0
orgn:	dw 0
padn:	dw 0
lineno:	dw 0
kind:	dw 0
rx:	dw 0
rw:	dw 0
cells:	dw 0
cstart:	dw 0

; emit byte in dl
emitb:	mov ah, 2
	int 0x21
	ret

; emit word in ax, little-endian
emitw:	push ax
	mov dx, ax
	call emitb
	pop ax
	mov dl, ah
	call emitb
	ret

main:	cld
	mov si, inp
	lodsw
	mov [rows], ax
	lodsw
	mov [orgn], ax
	lodsw
	mov [padn], ax

rowloop:
	mov ax, [rows]
	cmp ax, 0
	jne more
	mov dl, 4
	call emitb
	jmp exit
more:	dec ax
	mov [rows], ax
	lodsw
	mov [lineno], ax
	lodsb
	mov ah, 0
	mov [kind], ax
	lodsw
	mov [rx], ax
	lodsw
	mov [rw], ax
	lodsw
	mov [cells], ax
	mov ax, [kind]
	cmp ax, 5
	jne notpad

; pad row: flexbox already solved the fill size; check it landed on target
	mov ax, [rx]
	add ax, [rw]
	mov bx, [orgn]
	add bx, [padn]
	cmp ax, bx
	je padok
	mov al, 3
	jmp err
padok:	mov dl, 2
	call emitb
	mov ax, [rw]
	call emitw
	mov cx, [rw]
padz:	cmp cx, 0
	je padded
	mov dl, 0
	push cx
	call emitb
	pop cx
	dec cx
	jmp padz
padded:	jmp rowloop

; normal row, pass 1: validate every width, count live bytes into bx
notpad:	mov ax, si
	mov [cstart], ax
	mov bx, 0
	mov cx, [cells]
p1:	cmp cx, 0
	je p1done
	lodsw
	cmp ax, 0
	je p1next
	cmp ax, 1000
	jb bad1
	cmp ax, 1255
	ja bad1
	inc bx
p1next:	dec cx
	jmp p1
bad1:	mov al, 1
	jmp err

; expected byte count: 0 for org, else the strip width
p1done:	mov ax, [kind]
	cmp ax, 4
	jne exp1
	mov ax, 0
	jmp exp2
exp1:	mov ax, [rw]
exp2:	cmp bx, ax
	je countok
	mov ax, [kind]
	cmp ax, 0
	jne bad4
	mov al, 2
	jmp err
bad4:	mov al, 4
	jmp err

; an op that encodes to nothing means no CSS rule matched it
countok:
	mov ax, [kind]
	cmp ax, 0
	jne emitrow
	mov ax, [rw]
	cmp ax, 0
	jne emitrow
	mov al, 2
	jmp err

; pass 2: frame header, then the bytes themselves (width - 1000)
emitrow:
	mov dl, 2
	call emitb
	mov ax, bx
	call emitw
	mov si, [cstart]
	mov cx, [cells]
p2:	cmp cx, 0
	je p2done
	lodsw
	cmp ax, 0
	je p2next
	sub ax, 1000
	push cx
	mov dl, al
	call emitb
	pop cx
p2next:	dec cx
	jmp p2
p2done:	jmp rowloop

err:	mov dl, 3
	push ax
	call emitb
	mov ax, [lineno]
	call emitw
	pop ax
	mov dl, al
	call emitb
exit:	mov ax, 0x4c00
	int 0x21
inp:
