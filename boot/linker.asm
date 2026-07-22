; boot/linker.asm — symbol resolution for the bootstrapped accsembly chain.
; Builds the symbol table from measured label positions and equ box widths,
; resolves every reference, decides whether the relaxation loop has
; converged, and performs rel8 range diagnostics. Assembled by the
; stylesheet, executed by the 8086 interpreter. The harness only measures
; rectangles and copies these answers into DOM attributes.
;
; input, appended at inp:
;   u16 nlines, u16 nconsts
;   per const: u16 lineno, u16 value, u8 namelen, name
;   per line:  u16 idx, u16 lineno, u8 kind, u16 x, u16 w, u8 flags,
;              u16 atarget, u16 prevat, u16 prevto,
;              u8 namelen, name, u8 reflen, ref
;   kind: 0 op, 1 db, 2 dw, 3 lbl, 4 org, 5 pad
;   flags: 1 rel8 op, 2 has numeric target, 4 has prev at, 8 has prev to
; output frames (int 0x21 ah=2):
;   0x02 u16 idx, u16 at, u8 hasto, u16 to    patch
;   0x03 u16 lineno, u8 code, u16 aux, u8 namelen, name    fatal, stop
;     code 1 duplicate label, 2 duplicate symbol, 3 undefined, 4 rel8 range
;   0x05 not converged, run me again    0x04 converged and clean
	org 256
	jmp main

symbase	equ 0xF000

nlines:	dw 0
nconsts: dw 0
symn:	dw 0
lstart:	dw 0
chg:	dw 0
hasto:	dw 0
fval:	dw 0
aux:	dw 0
ecode:	dw 0
c1p:	dw 0
c1l:	dw 0
aptr:	dw 0
alen:	dw 0
aval:	dw 0
dupcode: dw 0
ridx:	dw 0
rlineno: dw 0
rkind:	dw 0
rx2:	dw 0
rww:	dw 0
rflags:	dw 0
ratgt:	dw 0
rpat:	dw 0
rpto:	dw 0
rnptr:	dw 0
rnlen:	dw 0
rrptr:	dw 0
rrlen:	dw 0

emitb:	mov ah, 2
	int 0x21
	ret

emitw:	push ax
	mov dx, ax
	call emitb
	pop ax
	mov dl, ah
	call emitb
	ret

; parse one line row at si into the r* vars
readrow:
	lodsw
	mov [ridx], ax
	lodsw
	mov [rlineno], ax
	lodsb
	mov ah, 0
	mov [rkind], ax
	lodsw
	mov [rx2], ax
	lodsw
	mov [rww], ax
	lodsb
	mov ah, 0
	mov [rflags], ax
	lodsw
	mov [ratgt], ax
	lodsw
	mov [rpat], ax
	lodsw
	mov [rpto], ax
	lodsb
	mov ah, 0
	mov [rnlen], ax
	mov [rnptr], si
	add si, ax
	lodsb
	mov ah, 0
	mov [rrlen], ax
	mov [rrptr], si
	add si, ax
	ret

; find symbol named (c1p, c1l); al=1 and fval on hit
symfind:
	mov cx, [symn]
	mov bx, symbase
sfloop:	cmp cx, 0
	je sfno
	mov al, [bx]
	mov ah, 0
	cmp ax, [c1l]
	jne sfskip
	push cx
	push si
	push di
	mov si, [bx+1]
	mov di, [c1p]
	mov cx, [c1l]
sfcmp:	cmp cx, 0
	je sfhit
	mov al, [si]
	mov dl, [di]
	cmp al, dl
	jne sfmiss
	inc si
	inc di
	dec cx
	jmp sfcmp
sfhit:	pop di
	pop si
	pop cx
	mov ax, [bx+3]
	mov [fval], ax
	mov al, 1
	ret
sfmiss:	pop di
	pop si
	pop cx
sfskip:	add bx, 5
	dec cx
	jmp sfloop
sfno:	mov al, 0
	ret

; add symbol (aptr, alen) = aval; duplicate -> fatal with dupcode
symadd:
	mov ax, [alen]
	mov [c1l], ax
	mov ax, [aptr]
	mov [c1p], ax
	call symfind
	cmp al, 0
	je addok
	mov ax, [dupcode]
	mov [ecode], ax
	mov ax, 0
	mov [aux], ax
	jmp errout
addok:	mov ax, [symn]
	mov bx, ax
	shl ax, 2
	add ax, bx
	add ax, symbase
	mov bx, ax
	mov ax, [alen]
	mov [bx], al
	mov ax, [aptr]
	mov [bx+1], ax
	mov ax, [aval]
	mov [bx+3], ax
	mov ax, [symn]
	inc ax
	mov [symn], ax
	ret

main:	cld
	mov si, inp
	lodsw
	mov [nlines], ax
	lodsw
	mov [nconsts], ax

; constants first: their value is the width of an out-of-flow box
	mov cx, [nconsts]
cloop:	cmp cx, 0
	je cdone
	push cx
	lodsw
	mov [rlineno], ax
	lodsw
	mov [aval], ax
	lodsb
	mov ah, 0
	mov [alen], ax
	mov [aptr], si
	add si, ax
	mov ax, 2
	mov [dupcode], ax
	call symadd
	pop cx
	dec cx
	jmp cloop
cdone:	mov [lstart], si

; labels: their value is their x coordinate
	mov cx, [nlines]
lloop:	cmp cx, 0
	je ldone
	push cx
	call readrow
	mov ax, [rkind]
	cmp ax, 3
	jne lnext
	mov ax, [rnlen]
	mov [alen], ax
	mov ax, [rnptr]
	mov [aptr], ax
	mov ax, [rx2]
	mov [aval], ax
	mov ax, 1
	mov [dupcode], ax
	call symadd
lnext:	pop cx
	dec cx
	jmp lloop
ldone:

; resolve every line, emit patches, track convergence
	mov si, [lstart]
	mov cx, [nlines]
	mov ax, 0
	mov [chg], ax
rloop:	cmp cx, 0
	jne rbody
	jmp rdone
rbody:	push cx
	call readrow
	mov ax, [rkind]
	cmp ax, 4
	jne notorg
	jmp rnext
notorg:	mov ax, 0
	mov [hasto], ax
	mov [fval], ax
	mov ax, [rrlen]
	cmp ax, 0
	je nofref
	mov [c1l], ax
	mov ax, [rrptr]
	mov [c1p], ax
	call symfind
	cmp al, 0
	jne fref
	mov ax, 3
	mov [ecode], ax
	mov ax, 0
	mov [aux], ax
	jmp errout
fref:	mov ax, 1
	mov [hasto], ax
nofref:
	mov dl, 2
	call emitb
	mov ax, [ridx]
	call emitw
	mov ax, [rx2]
	call emitw
	mov ax, [hasto]
	mov dl, al
	call emitb
	mov ax, [fval]
	call emitw
; converged for this line iff prev at exists and matches, and prev to
; agrees with the freshly resolved to
	mov ax, [rflags]
	and ax, 4
	cmp ax, 0
	je changed
	mov ax, [rpat]
	cmp ax, [rx2]
	jne changed
	mov ax, [rflags]
	and ax, 8
	cmp ax, 0
	je noprevto
	mov ax, 1
	jmp pt2
noprevto:
	mov ax, 0
pt2:	cmp ax, [hasto]
	jne changed
	mov ax, [hasto]
	cmp ax, 0
	je rnext
	mov ax, [rpto]
	cmp ax, [fval]
	jne changed
	jmp rnext
changed:
	mov ax, 1
	mov [chg], ax
rnext:	pop cx
	dec cx
	jmp rloop
rdone:
	mov ax, [chg]
	cmp ax, 0
	je conv
	mov dl, 5
	call emitb
	jmp exit

; converged: rel8 range diagnostics (the stylesheet would silently wrap)
conv:	mov si, [lstart]
	mov cx, [nlines]
gloop:	cmp cx, 0
	jne gbody
	jmp gdone
gbody:	push cx
	call readrow
	mov ax, [rflags]
	and ax, 1
	cmp ax, 0
	jne grel
	jmp gnext
grel:	mov ax, [rrlen]
	cmp ax, 0
	je gnoref
	mov [c1l], ax
	mov ax, [rrptr]
	mov [c1p], ax
	call symfind
	mov ax, [fval]
	jmp gtgt
gnoref:	mov ax, [rflags]
	and ax, 2
	cmp ax, 0
	je gnext
	mov ax, [ratgt]
gtgt:	sub ax, [rx2]
	sub ax, 2
	cmp ax, -128
	jl grange
	cmp ax, 127
	jg grange
	jmp gnext
grange:	mov [aux], ax
	mov ax, 4
	mov [ecode], ax
	mov ax, 0
	mov [c1l], ax
	jmp errout
gnext:	pop cx
	dec cx
	jmp gloop
gdone:	mov dl, 4
	call emitb
	jmp exit

errout:	mov dl, 3
	call emitb
	mov ax, [rlineno]
	call emitw
	mov ax, [ecode]
	mov dl, al
	call emitb
	mov ax, [aux]
	call emitw
	mov ax, [c1l]
	mov dl, al
	call emitb
	mov cx, [c1l]
	mov bx, [c1p]
enl:	cmp cx, 0
	je exit
	mov al, [bx]
	mov dl, al
	push cx
	push bx
	call emitb
	pop bx
	pop cx
	inc bx
	dec cx
	jmp enl
exit:	mov ax, 0x4c00
	int 0x21
inp:
