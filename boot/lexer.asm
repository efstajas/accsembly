; boot/lexer.asm — the accsembly tokenizer, written in the dialect it
; tokenizes, assembled by assembler.css, executed by an 8086. It reads
; source text appended to its own binary image (at src:, terminated by
; byte 255) and emits one record per source item on stdout (int 0x21
; ah=2), fields separated by byte 1, records by newline:
;
;   I <idx> <lineno> <kind> <name> <n> <ref> <refrole> <r8> <atarget> <attrs> <cells> <src>
;   E <lineno> <message>
;
; kind: o op, d db, w dw, l lbl, g org, p pad, e equ, b blank.
; attrs is the ready-to-splice attribute text (k=, op=, a=, ma1=, sz=,
; mseg=, lock, fseg/foff, hex digit wires ha*/hb*/hd*, c=). cells is the
; inner markup for db/dw lines. The harness stamps these into the four
; page sections verbatim; it never inspects them.
	org 256
	jmp main

obuf	equ 0xE000
abuf	equ 0xD000
spbase	equ 0xFFF0

lineno:	dw 0
idx:	dw 1
orgsn:	dw 0
codesn:	dw 0
padsn:	dw 0
hadlbl:	dw 0
lstart:	dw 0
lend:	dw 0
lendm:	dw 0
cmtp:	dw 0
cmtch:	dw 0
ai:	dw 0
szv:	dw 0
msegv:	dw 0
lockf:	dw 0
memc:	dw 0
chrc:	dw 0
refp:	dw 0
refl:	dw 0
refrl:	dw 0
atgp:	dw 0
atgl:	dw 0
r8f:	dw 0
opp:	dw 0
opl:	dw 0
farfl:	dw 0
fsp:	dw 0
fsl:	dw 0
fop:	dw 0
fol:	dw 0
slotc:	dw 0
t1p:	dw 0
t1l:	dw 0
t2p:	dw 0
t2l:	dw 0
tsign:	dw 0
emsg:	dw 0
dbcnt:	dw 0
mw1p:	dw 0
mw1l:	dw 0
mw2p:	dw 0
mw2l:	dw 0
mdsp:	dw 0
mdsl:	dw 0
mdsg:	dw 0
mhxp:	dw 0
mhxl:	dw 0
mhxs:	dw 0
mwc:	dw 0
mdc:	dw 0
c1p:	dw 0
c1l:	dw 0
c2p:	dw 0
c2l:	dw 0
savsi:	dw 0
savp:	dw 0
eqvp:	dw 0
eqvl:	dw 0

; ---- string tables --------------------------------------------------------
regtbl:	db "axcxdxbxspbpsidialcldlblahchdhbhescsssds"
kwtbl:	db "movsbmovswcmpsbcmpswstosbstoswlodsblodswscasbscasw"
sztbl:	db 4, "byte", 4, "word", 5, "short", 4, "near", 3, "far", 0
reltbl:	db 2, "je", 2, "jz", 3, "jne", 3, "jnz", 2, "jb", 3, "jae"
	db 3, "jbe", 2, "ja", 2, "jl", 3, "jge", 3, "jle", 2, "jg"
	db 4, "loop", 2, "jo", 3, "jno", 2, "jc", 3, "jnc", 2, "js"
	db 3, "jns", 2, "jp", 3, "jpe", 3, "jnp", 3, "jpo", 4, "jcxz"
	db 5, "loope", 5, "loopz", 6, "loopne", 6, "loopnz", 0
segtbl:	db "escsssds"

kblank:	db "blank", 0
klbl:	db "lbl", 0
kequ:	db "equ", 0
kdb:	db "db", 0
kdw:	db "dw", 0
korg:	db "org", 0
kpad:	db "pad", 0
kop:	db "op", 0
aname:	db " name=", 34, 0
aan:	db " n=", 34, 0
qend:	db 34, 0
sorgimp: db "org 256 (implicit)", 0
n256:	db "256", 0
amps:	db "&amp;", 0
lts:	db "&lt;", 0
gts:	db "&gt;", 0
quots:	db "&quot;", 0
celld:	db "<d ", 0
cellde:	db "></d>", 0
cellw:	db "<w ", 0
cellwe:	db "><e></e><e></e></w>", 0
aeq:	db "=", 34, 0
alock:	db " lock=", 34, 34, 0
hneg:	db "neg=", 34, 34, 0

; ---- error messages -------------------------------------------------------
munterm: db "unterminated string", 0
mbadchr: db "bad character literal", 0
mbaddb:	db "bad db operand (decimal, hex, string, or char)", 0
mcomma:	db "expected comma between operands", 0
mdbone:	db "db needs at least one operand", 0
mdwop:	db "bad dw operand (decimal, hex, or label names)", 0
mdwsep:	db "dw needs comma-separated operands", 0
mpadn:	db "pad needs a decimal target offset", 0
morgn:	db "org needs a decimal address", 0
mequv:	db "equ needs a number, 0x hex, or a char literal", 0
mtwoop:	db "expected at most two comma-separated operands", 0
mbadop:	db "bad operand (decimal, 0x hex, char, seg:off, or a name)", 0
mbadmp:	db "bad memory operand part", 0
mempty:	db "empty memory operand []", 0
mterms:	db "too many terms in memory operand", 0
mdisp1:	db "at most one displacement in memory operand", 0
mlock:	db "lock needs an instruction to hold on to", 0
mszcon:	db "conflicting size keywords", 0
mchr1:	db "one character literal per line (the stylesheet has a single c wire)", 0
mmem1:	db "at most one memory operand per instruction (x86 agrees)", 0
mmemw2:	db "unsupported memory operand (base register first, index register second)", 0
mref1:	db "one symbol reference per line (the stylesheet has one to wire per role)", 0
morg1:	db "only one org, and it must come first", 0
morg2:	db "org must come before any code", 0
mpad1:	db "only one pad per program", 0

; ==== low-level emitters ===================================================
; obuf cursor lives in di; abuf cursor in [ai]

; append char al to abuf
aput:	push di
	mov di, [ai]
	stosb
	mov [ai], di
	pop di
	ret

; append 0-terminated string bx to abuf
astrz:	push di
	mov di, [ai]
as1:	mov al, [bx]
	cmp al, 0
	je as2
	stosb
	inc bx
	jmp as1
as2:	mov [ai], di
	pop di
	ret

; append escaped char al to abuf
aesc:	cmp al, '&'
	je aeamp
	cmp al, '<'
	je aelt
	cmp al, '>'
	je aegt
	cmp al, 34
	je aequo
	call aput
	ret
aeamp:	mov bx, amps
	call astrz
	ret
aelt:	mov bx, lts
	call astrz
	ret
aegt:	mov bx, gts
	call astrz
	ret
aequo:	mov bx, quots
	call astrz
	ret

; append escaped span (bx=ptr, cx=len) to abuf
aspan:	cmp cx, 0
	je asp2
	push cx
	push bx
	mov al, [bx]
	call aesc
	pop bx
	pop cx
	inc bx
	dec cx
	jmp aspan
asp2:	ret

; emit char al to obuf (record buffer)
bput:	stosb
	ret

; emit 0-terminated string bx to obuf
bstrz:	mov al, [bx]
	cmp al, 0
	je bs2
	stosb
	inc bx
	jmp bstrz
bs2:	ret

; emit escaped char al to obuf
besc:	cmp al, '&'
	je beamp
	cmp al, '<'
	je belt
	cmp al, '>'
	je begt
	cmp al, 34
	je bequo
	stosb
	ret
beamp:	mov bx, amps
	call bstrz
	ret
belt:	mov bx, lts
	call bstrz
	ret
begt:	mov bx, gts
	call bstrz
	ret
bequo:	mov bx, quots
	call bstrz
	ret

; emit escaped span (bx, cx) to obuf
bspan:	cmp cx, 0
	je bsp2
	push cx
	push bx
	mov al, [bx]
	call besc
	pop bx
	pop cx
	inc bx
	dec cx
	jmp bspan
bsp2:	ret

; emit raw span (bx, cx) to obuf
brawsp:	cmp cx, 0
	je brw2
	mov al, [bx]
	stosb
	inc bx
	dec cx
	jmp brawsp
brw2:	ret

; emit decimal of ax to obuf
bdec:	mov cx, 0
	mov bx, 10
bd1:	mov dx, 0
	div bx
	push dx
	inc cx
	cmp ax, 0
	jne bd1
bd2:	pop ax
	add al, '0'
	stosb
	dec cx
	jne bd2
	ret

; emit field separator / newline to obuf
bfs:	mov al, 1
	stosb
	ret
bnl:	mov al, 10
	stosb
	ret

; flush obuf (start..di) to stdout, reset di
flush:	mov bx, obuf
fl1:	cmp bx, di
	je fl2
	mov dl, [bx]
	mov ah, 2
	int 0x21
	inc bx
	jmp fl1
fl2:	mov di, obuf
	ret

; fatal line error: [emsg] holds the message; emits E record, aborts line
erec:	mov sp, spbase
	mov di, obuf
	mov al, 'E'
	stosb
	call bfs
	mov ax, [lineno]
	call bdec
	call bfs
	mov bx, [emsg]
	call bstrz
	call bnl
	call flush
	jmp lrest

; ==== char classes =========================================================
; tolower al
lower:	cmp al, 'A'
	jb lw2
	cmp al, 'Z'
	ja lw2
	add al, 32
lw2:	ret

; carry set if al is space/tab
isws:	cmp al, ' '
	je iw1
	cmp al, 9
	je iw1
	clc
	ret
iw1:	stc
	ret

; carry set if al is a digit
isdig:	cmp al, '0'
	jb id0
	cmp al, '9'
	ja id0
	stc
	ret
id0:	clc
	ret

; carry set if al is an identifier start ([A-Za-z_])
isid0:	push ax
	call lower
	cmp al, '_'
	je ii1
	cmp al, 'a'
	jb ii0
	cmp al, 'z'
	ja ii0
ii1:	pop ax
	stc
	ret
ii0:	pop ax
	clc
	ret

; carry set if al is an identifier char ([A-Za-z0-9_])
isidc:	call isdig
	jc ic1
	call isid0
	jc ic1
	clc
	ret
ic1:	stc
	ret

; carry set if al is a hex digit (case-insensitive)
ishexd:	push ax
	call lower
	cmp al, '0'
	jb ihx0
	cmp al, '9'
	jbe ihx1
	cmp al, 'a'
	jb ihx0
	cmp al, 'f'
	ja ihx0
ihx1:	pop ax
	stc
	ret
ihx0:	pop ax
	clc
	ret

; skip whitespace at si
skipws:	mov al, [si]
	call isws
	jnc sw2
	inc si
	jmp skipws
sw2:	ret

; scan identifier at si -> bx=start, cx=len (0 if none), si advanced
identsc: mov bx, si
	mov cx, 0
	mov al, [si]
	call isid0
	jnc is2
is1:	inc si
	inc cx
	mov al, [si]
	call isidc
	jc is1
is2:	ret

; ==== table lookups ========================================================
; register check: name at [t1p] len [t1l]; carry set if it is a register
regchk:	mov ax, [t1l]
	cmp ax, 2
	jne rc0
	mov bx, [t1p]
	mov al, [bx]
	call lower
	mov dl, al
	mov al, [bx+1]
	call lower
	mov dh, al
	mov bx, regtbl
	mov cx, 20
rc1:	mov al, [bx]
	cmp al, dl
	jne rc2
	mov al, [bx+1]
	cmp al, dh
	jne rc2
	stc
	ret
rc2:	add bx, 2
	dec cx
	jne rc1
rc0:	clc
	ret

; string-op keyword check (movsb etc, all length 5): carry if matched
kwchk:	mov ax, [t1l]
	cmp ax, 5
	jne kw0
	mov cx, 10
	mov bx, kwtbl
kw1:	push cx
	mov cx, 5
	mov dx, [t1p]
kw2:	push bx
	mov al, [bx]
	call lower
	mov ah, al
	mov bx, dx
	mov al, [bx]
	call lower
	pop bx
	cmp al, ah
	jne kw3
	inc bx
	inc dx
	dec cx
	jne kw2
	pop cx
	stc
	ret
kw3:	add bx, cx
	pop cx
	dec cx
	jne kw1
	clc
	ret
kw0:	clc
	ret

; generic length-prefixed table lookup: table at bx, name [t1p]/[t1l];
; returns carry + index in dx (1-based) if found
tblchk:	mov dx, 1
tb1:	mov al, [bx]
	cmp al, 0
	je tb0
	mov ah, 0
	mov cx, ax
	cmp cx, [t1l]
	jne tb4
	; compare cx bytes at bx+1 vs t1p, case-insensitively
	push bx
	push dx
	inc bx
	mov dx, [t1p]
tb2:	push bx
	mov al, [bx]
	call lower
	mov ah, al
	mov bx, dx
	mov al, [bx]
	call lower
	pop bx
	cmp al, ah
	jne tb3
	inc bx
	inc dx
	dec cx
	jne tb2
	pop dx
	pop bx
	stc
	ret
tb3:	add bx, cx
	pop dx
	pop bx
	mov al, [bx]
	mov ah, 0
	mov cx, ax
tb4:	inc bx
	add bx, cx
	inc dx
	jmp tb1
tb0:	clc
	ret

; compare names (c1p,c1l) vs (c2p,c2l), case-sensitively; carry if equal
nmeq:	mov ax, [c1l]
	cmp ax, [c2l]
	jne nq0
	mov cx, ax
	cmp cx, 0
	je nq1
	mov bx, [c1p]
	mov dx, [c2p]
nq2:	mov al, [bx]
	push bx
	mov bx, dx
	mov ah, [bx]
	pop bx
	cmp al, ah
	jne nq0
	inc bx
	inc dx
	dec cx
	jne nq2
nq1:	stc
	ret
nq0:	clc
	ret

; ==== token validators =====================================================
; NUM check over (t1p, t1l): optional leading -, then digits; carry if ok
numchk:	mov cx, [t1l]
	cmp cx, 0
	je nc0
	mov bx, [t1p]
	mov al, [bx]
	cmp al, '-'
	jne nc1
	inc bx
	dec cx
	cmp cx, 0
	je nc0
nc1:	mov al, [bx]
	call isdig
	jnc nc0
	inc bx
	dec cx
	jne nc1
	stc
	ret
nc0:	clc
	ret

; HEX check over (t1p, t1l): -?0x[hexdigit]{1,4}; carry if ok
hexchk:	mov cx, [t1l]
	mov bx, [t1p]
	mov al, [bx]
	cmp al, '-'
	jne hc1
	inc bx
	dec cx
hc1:	cmp cx, 3
	jb hc0
	cmp cx, 6
	ja hc0
	mov al, [bx]
	cmp al, '0'
	jne hc0
	mov al, [bx+1]
	call lower
	cmp al, 'x'
	jne hc0
	add bx, 2
	sub cx, 2
hc2:	mov al, [bx]
	call ishexd
	jnc hc0
	inc bx
	dec cx
	jne hc2
	stc
	ret
hc0:	clc
	ret

; ==== hex wire emission ====================================================
; emit hex-digit attrs for token (t1p,t1l) with role prefix char in dl
; ('a','b','d'): " haN=\"x\"" ... plus " hanegg=\"\"" if negative.
; goes to abuf.
hwire:	mov ax, [t1p]
	mov [t2p], ax
	mov ax, [t1l]
	mov [t2l], ax
	mov ax, 0
	mov [tsign], ax
	mov bx, [t2p]
	mov al, [bx]
	cmp al, '-'
	jne hw1
	mov ax, 1
	mov [tsign], ax
	mov ax, [t2p]
	inc ax
	mov [t2p], ax
	mov ax, [t2l]
	dec ax
	mov [t2l], ax
hw1:	; skip the 0x
	mov ax, [t2p]
	add ax, 2
	mov [t2p], ax
	mov ax, [t2l]
	sub ax, 2
	mov [t2l], ax
	; emit 4 digit attrs, left-padded with '0'
	mov cx, 4
	push dx
hw2:	pop dx
	push dx
	push cx
	; attr name: " h<role><digitpos>=""
	mov al, ' '
	call aput
	mov al, 'h'
	call aput
	mov al, dl
	call aput
	pop cx
	push cx
	mov ax, 5
	sub ax, cx
	add al, '0'
	call aput
	mov bx, aeq
	call astrz
	; value: '0' pad while 4-pos < 4-len ... i.e. pos <= 4-len
	pop cx
	push cx
	mov ax, 5
	sub ax, cx
	mov bx, 4
	sub bx, [t2l]
	cmp ax, bx
	ja hw3
	mov al, '0'
	call aput
	jmp hw4
hw3:	; real digit: index = pos-1 - (4-len)
	dec ax
	sub ax, bx
	mov bx, [t2p]
	add bx, ax
	mov al, [bx]
	call lower
	call aput
hw4:	mov bx, qend
	call astrz
	pop cx
	dec cx
	jne hw2
	pop dx
	; negative marker
	mov ax, [tsign]
	cmp ax, 0
	je hw5
	mov al, ' '
	call aput
	mov al, 'h'
	call aput
	mov al, dl
	call aput
	mov bx, hneg
	call astrz
hw5:	ret

; same, but into obuf with plain h1..h4 names (db/dw cells, equ)
hcell:	mov ax, [t1p]
	mov [t2p], ax
	mov ax, [t1l]
	mov [t2l], ax
	mov ax, 0
	mov [tsign], ax
	mov bx, [t2p]
	mov al, [bx]
	cmp al, '-'
	jne hb1
	mov ax, 1
	mov [tsign], ax
	mov ax, [t2p]
	inc ax
	mov [t2p], ax
	mov ax, [t2l]
	dec ax
	mov [t2l], ax
hb1:	mov ax, [t2p]
	add ax, 2
	mov [t2p], ax
	mov ax, [t2l]
	sub ax, 2
	mov [t2l], ax
	mov cx, 4
hb2:	push cx
	mov al, 'h'
	stosb
	mov ax, 5
	sub ax, cx
	add al, '0'
	stosb
	mov bx, aeq
	call bstrz
	pop cx
	push cx
	mov ax, 5
	sub ax, cx
	mov bx, 4
	sub bx, [t2l]
	cmp ax, bx
	ja hb3
	mov al, '0'
	stosb
	jmp hb4
hb3:	dec ax
	sub ax, bx
	mov bx, [t2p]
	add bx, ax
	mov al, [bx]
	call lower
	stosb
hb4:	mov bx, qend
	call bstrz
	pop cx
	cmp cx, 1
	je hb5
	mov al, ' '
	stosb
hb5:	dec cx
	jne hb2
	mov ax, [tsign]
	cmp ax, 0
	je hb6
	mov al, ' '
	stosb
	mov al, 'h'
	stosb
	mov bx, hneg
	call bstrz
hb6:	ret

; ==== the shared record head ==============================================
; 'I' FS idx FS lineno FS <kindchar in al> FS ; bumps idx
rhead:	push ax
	mov al, 'I'
	stosb
	call bfs
	mov ax, [idx]
	call bdec
	mov ax, [idx]
	inc ax
	mov [idx], ax
	call bfs
	mov ax, [lineno]
	call bdec
	call bfs
	pop ax
	stosb
	call bfs
	ret

; emit the raw source line (restoring any comment) then newline, flush.
; comment char restored permanently afterwards (line is done).
srcraw:	mov ax, [cmtp]
	cmp ax, 0
	je sr1
	mov bx, ax
	mov ax, [cmtch]
	mov [bx], al
sr1:	mov bx, [lstart]
	mov cx, [lend]
	sub cx, [lstart]
	call bspan
	call bnl
	call flush
	ret

; emit source as 4 spaces + comment-stripped rest from [savp]; flush
srclbl:	mov cx, 4
sl1:	mov al, ' '
	stosb
	dec cx
	jne sl1
	mov bx, [savp]
sl2:	mov al, [bx]
	cmp al, 0
	je sl3
	push bx
	call besc
	pop bx
	inc bx
	jmp sl2
sl3:	call bnl
	call flush
	ret

; ==== operand parsing ======================================================
; parse one operand at si; slot char in [slotc] ('a' or 'b').
; attrs appended to abuf; ref/wire/etc vars updated. ends with si after
; the operand. jumps to erec on error.
opparse:
	; size keyword?
	mov ax, si
	mov [savsi], ax
	call identsc
	cmp cx, 0
	je op1
	mov [t1p], bx
	mov [t1l], cx
	mov bx, sztbl
	call tblchk
	jnc op1a
	; a size word followed by more content is a keyword, else an operand
	push dx
	call skipws
	pop dx
	mov al, [si]
	cmp al, 0
	je op1a
	cmp al, ','
	je op1a
	; commit the size keyword (conflict check)
	mov ax, [szv]
	cmp ax, 0
	je op0c
	cmp ax, dx
	je op0d
	mov ax, mszcon
	mov [emsg], ax
	jmp erec
op0c:	mov [szv], dx
op0d:	jmp opparse
op1a:	; not a size keyword: rewind and treat as plain token
	mov ax, [savsi]
	mov si, ax
op1:	mov ax, [savsi]
	mov si, ax
	mov al, [si]
	cmp al, '['
	jne op2
	jmp memparse
op2:	cmp al, 39
	jne op3
	; char literal 'x'
	mov al, [si+2]
	cmp al, 39
	je op2a
	mov ax, mbadop
	mov [emsg], ax
	jmp erec
op2a:	mov ax, [chrc]
	cmp ax, 0
	je op2b
	mov ax, mchr1
	mov [emsg], ax
	jmp erec
op2b:	inc ax
	mov [chrc], ax
	; a/b attr with the raw 'x' token; c wire with the char
	mov al, ' '
	call aput
	mov ax, [slotc]
	call aput
	mov bx, aeq
	call astrz
	mov bx, si
	mov cx, 3
	call aspan
	mov bx, qend
	call astrz
	mov al, ' '
	call aput
	mov al, 'c'
	call aput
	mov bx, aeq
	call astrz
	mov al, [si+1]
	call aesc
	mov bx, qend
	call astrz
	add si, 3
	; nothing may trail the closing quote except ws/comma/end
	mov al, [si]
	call isws
	jc op2z
	cmp al, ','
	je op2z
	cmp al, 0
	je op2z
	mov ax, mbadop
	mov [emsg], ax
	jmp erec
op2z:	ret
op3:	; number / hex / ident / far pointer
	mov bx, si
	mov cx, 0
	mov al, [si]
	cmp al, '-'
	jne op3a
	inc si
	inc cx
op3a:	mov al, [si]
	call isidc
	jnc op3b
	inc si
	inc cx
	jmp op3a
op3b:	cmp cx, 0
	jne op3c
	mov ax, mbadop
	mov [emsg], ax
	jmp erec
op3c:	mov [t1p], bx
	mov [t1l], cx
	; far pointer?
	mov al, [si]
	cmp al, ':'
	jne op4
	; first half must be numeric
	call numchk
	jc op3d
	call hexchk
	jc op3d
	mov ax, mbadop
	mov [emsg], ax
	jmp erec
op3d:	mov ax, [t1p]
	mov [fsp], ax
	mov ax, [t1l]
	mov [fsl], ax
	inc si
	mov bx, si
	mov cx, 0
	mov al, [si]
	cmp al, '-'
	jne op3e
	inc si
	inc cx
op3e:	mov al, [si]
	call isidc
	jnc op3f
	inc si
	inc cx
	jmp op3e
op3f:	mov [t1p], bx
	mov [t1l], cx
	call numchk
	jc op3g
	call hexchk
	jc op3g
	mov ax, mbadop
	mov [emsg], ax
	jmp erec
op3g:	mov ax, [t1p]
	mov [fop], ax
	mov ax, [t1l]
	mov [fol], ax
	mov ax, 1
	mov [farfl], ax
	ret
op4:	; classify the single token
	call numchk
	jnc op5
	; plain decimal: a/b attr; possible atarget when in slot a
	call pattr
	mov ax, [slotc]
	cmp ax, 'a'
	jne op4z
	mov ax, [t1p]
	mov [atgp], ax
	mov ax, [t1l]
	mov [atgl], ax
op4z:	ret
op5:	call hexchk
	jnc op6
	; hex literal: a/b attr with raw token + role wire
	call pattr
	mov ax, [slotc]
	mov dx, ax
	call hwire
	ret
op6:	; identifier?
	mov bx, [t1p]
	mov al, [bx]
	call isid0
	jc op7
	mov ax, mbadop
	mov [emsg], ax
	jmp erec
op7:	call pattr
	; ref candidate unless register or string-op keyword
	call regchk
	jc op8
	call kwchk
	jc op8
	mov ax, [slotc]
	call refcand
op8:	ret

; append " <slot>=\"<escaped t1 token>\"" to abuf
pattr:	mov al, ' '
	call aput
	mov ax, [slotc]
	call aput
	mov bx, aeq
	call astrz
	mov bx, [t1p]
	mov cx, [t1l]
	call aspan
	mov bx, qend
	call astrz
	ret

; register a symbol reference: name (t1p,t1l), role char in al.
; same name again just updates the role; a different name is fatal.
refcand: push ax
	mov ax, [refl]
	cmp ax, 0
	je rf1
	; compare with existing
	mov ax, [refp]
	mov [c1p], ax
	mov ax, [refl]
	mov [c1l], ax
	mov ax, [t1p]
	mov [c2p], ax
	mov ax, [t1l]
	mov [c2l], ax
	call nmeq
	jc rf2
	mov ax, mref1
	mov [emsg], ax
	jmp erec
rf1:	mov ax, [t1p]
	mov [refp], ax
	mov ax, [t1l]
	mov [refl], ax
rf2:	pop ax
	mov [refrl], ax
	ret

; ==== memory operand =======================================================
; si at '['. emits maN/mbN attrs (+ possible seg / hd wires), tracks ref.
memparse:
	mov ax, [memc]
	cmp ax, 0
	je mp0
	mov ax, mmem1
	mov [emsg], ax
	jmp erec
mp0:	inc ax
	mov [memc], ax
	inc si
	mov ax, 0
	mov [mw1l], ax
	mov [mw2l], ax
	mov [mdsl], ax
	mov [mdsg], ax
	mov [mhxl], ax
	mov [mhxs], ax
	mov [mwc], ax
	mov [mdc], ax
	; segment override?
	call skipws
	mov ax, si
	mov [savsi], ax
	call identsc
	cmp cx, 2
	jne mp2
	push bx
	push cx
	call skipws
	pop cx
	pop bx
	mov al, [si]
	cmp al, ':'
	jne mp2
	; check against es/cs/ss/ds (4 x 2 chars in segtbl)
	mov [t1p], bx
	mov [t1l], cx
	mov bx, [t1p]
	mov al, [bx]
	call lower
	mov dl, al
	mov al, [bx+1]
	call lower
	mov dh, al
	mov bx, segtbl
	mov cx, 4
mp1a:	mov al, [bx]
	cmp al, dl
	jne mp1b
	mov al, [bx+1]
	cmp al, dh
	jne mp1b
	; matched: index 5-cx
	mov ax, 5
	sub ax, cx
	mov [msegv], ax
	inc si
	jmp mp3
mp1b:	add bx, 2
	dec cx
	jne mp1a
	; ident:  but not a segment register -> not an override
mp2:	mov ax, [savsi]
	mov si, ax
mp3:	; term loop
	call skipws
	mov al, [si]
	cmp al, ']'
	jne mp4
	; empty []
	mov ax, [mwc]
	add ax, [mdc]
	cmp ax, 0
	jne mpdone0
	mov ax, mempty
	mov [emsg], ax
	jmp erec
mpdone0: jmp mpdone
mp4:	cmp al, 0
	jne mp5
	mov ax, mbadmp
	mov [emsg], ax
	jmp erec
mp5:	cmp al, '+'
	jne mp6
	inc si
	jmp mp3
mp6:	cmp al, '-'
	je mp6n
	mov ax, 0
	mov [tsign], ax
	jmp mp7
mp6n:	mov ax, 1
	mov [tsign], ax
	inc si
	call skipws
mp7:	; term: ident / number / hex
	mov bx, si
	mov cx, 0
mp7a:	mov al, [si]
	call isidc
	jnc mp7b
	inc si
	inc cx
	jmp mp7a
mp7b:	cmp cx, 0
	jne mp7c
	mov ax, mbadmp
	mov [emsg], ax
	jmp erec
mp7c:	mov [t1p], bx
	mov [t1l], cx
	; classify: digits -> disp, 0x -> hex disp, ident -> word
	call numchk
	jnc mpc1
	jmp mpnum
mpc1:	call hexchk
	jnc mpc2
	jmp mphex
mpc2:	mov bx, [t1p]
	mov al, [bx]
	call isid0
	jc mpword
	; a '-' before an ident, or garbage
	mov ax, mbadmp
	mov [emsg], ax
	jmp erec
mpword:	mov ax, [tsign]
	cmp ax, 0
	je mpw0
	mov ax, mbadmp
	mov [emsg], ax
	jmp erec
mpw0:	mov ax, [mwc]
	cmp ax, 2
	jb mpw1
	mov ax, mterms
	mov [emsg], ax
	jmp erec
mpw1:	cmp ax, 0
	jne mpw2
	mov ax, [t1p]
	mov [mw1p], ax
	mov ax, [t1l]
	mov [mw1l], ax
	jmp mpw3
mpw2:	mov ax, [t1p]
	mov [mw2p], ax
	mov ax, [t1l]
	mov [mw2l], ax
mpw3:	mov ax, [mwc]
	inc ax
	mov [mwc], ax
	jmp mp3
mpnum:	mov ax, [mdc]
	cmp ax, 0
	je mpn1
	mov ax, mdisp1
	mov [emsg], ax
	jmp erec
mpn1:	inc ax
	mov [mdc], ax
	mov ax, [t1p]
	mov [mdsp], ax
	mov ax, [t1l]
	mov [mdsl], ax
	mov ax, [tsign]
	mov [mdsg], ax
	jmp mp3
mphex:	mov ax, [mdc]
	cmp ax, 0
	je mph1
	mov ax, mdisp1
	mov [emsg], ax
	jmp erec
mph1:	inc ax
	mov [mdc], ax
	mov ax, [t1p]
	mov [mhxp], ax
	mov ax, [t1l]
	mov [mhxl], ax
	mov ax, [tsign]
	mov [mhxs], ax
	jmp mp3

; done: ']' consumed here; emit attrs
mpdone:	inc si
	; w2, when present, must be a register
	mov ax, [mw2l]
	cmp ax, 0
	je mq1
	mov ax, [mw2p]
	mov [t1p], ax
	mov ax, [mw2l]
	mov [t1l], ax
	call regchk
	jc mq1
	mov ax, mmemw2
	mov [emsg], ax
	jmp erec
mq1:	; w1: register or symbol ref (role d)
	mov ax, [mw1l]
	cmp ax, 0
	je mq2
	mov ax, [mw1p]
	mov [t1p], ax
	mov ax, [mw1l]
	mov [t1l], ax
	call regchk
	jc mq2
	mov ax, 'd'
	call refcand
mq2:	; attr prefix letter: 'a' slot -> "ma", 'b' -> "mb"
	; ma1/mb1
	mov ax, [mw1l]
	cmp ax, 0
	je mq3
	mov al, ' '
	call aput
	mov al, 'm'
	call aput
	mov ax, [slotc]
	call aput
	mov al, '1'
	call aput
	mov bx, aeq
	call astrz
	mov bx, [mw1p]
	mov cx, [mw1l]
	call aspan
	mov bx, qend
	call astrz
mq3:	mov ax, [mw2l]
	cmp ax, 0
	je mq4
	mov al, ' '
	call aput
	mov al, 'm'
	call aput
	mov ax, [slotc]
	call aput
	mov al, '2'
	call aput
	mov bx, aeq
	call astrz
	mov bx, [mw2p]
	mov cx, [mw2l]
	call aspan
	mov bx, qend
	call astrz
mq4:	; displacement: decimal (raw, signed) or hex (mad="0" + hd wires)
	mov ax, [mdsl]
	cmp ax, 0
	je mq5
	mov al, ' '
	call aput
	mov al, 'm'
	call aput
	mov ax, [slotc]
	call aput
	mov al, 'd'
	call aput
	mov bx, aeq
	call astrz
	mov ax, [mdsg]
	cmp ax, 0
	je mq4a
	mov al, '-'
	call aput
mq4a:	mov bx, [mdsp]
	mov cx, [mdsl]
	call aspan
	mov bx, qend
	call astrz
	ret
mq5:	mov ax, [mhxl]
	cmp ax, 0
	je mq6
	mov al, ' '
	call aput
	mov al, 'm'
	call aput
	mov ax, [slotc]
	call aput
	mov al, 'd'
	call aput
	mov bx, aeq
	call astrz
	mov al, '0'
	call aput
	mov bx, qend
	call astrz
	; hd wires want the sign folded into the token; rebuild via t1 + tsign
	mov ax, [mhxp]
	mov [t1p], ax
	mov ax, [mhxl]
	mov [t1l], ax
	; hwire reads the leading '-' from the token itself; if the sign was
	; separated by whitespace, point at a synthetic prefix: emit wires by
	; hand instead. simplest correct move: temporarily treat sign flag.
	mov ax, [mhxs]
	cmp ax, 0
	je mq5a
	; negative: emit digits then the neg marker, using hwire on the
	; unsigned token and appending hdneg ourselves
	mov dx, 'd'
	call hwire
	mov al, ' '
	call aput
	mov al, 'h'
	call aput
	mov al, 'd'
	call aput
	mov bx, hneg
	call astrz
	ret
mq5a:	mov dx, 'd'
	call hwire
mq6:	ret

; ==== per-kind handlers ====================================================

; ---- db ----
dodb:	mov al, 'd'
	call rhead
	; name, n, ref, refrole, r8, atarget all empty
	call bfs
	call bfs
	call bfs
	call bfs
	call bfs
	call bfs
	; attrs
	mov al, ' '
	stosb
	mov al, 'k'
	stosb
	mov bx, aeq
	call bstrz
	mov bx, kdb
	call bstrz
	mov bx, qend
	call bstrz
	call bfs
	; cells, parsed directly
	mov ax, 0
	mov [dbcnt], ax
db1:	call skipws
	mov al, [si]
	cmp al, 0
	jne db1a
	jmp db9
db1a:	cmp al, 34
	jne db1b
	jmp dbstr
db1b:	cmp al, 39
	jne db1c
	jmp dbchr
db1c:
	; numeric / hex token up to , or ws
	mov bx, si
	mov cx, 0
db2:	mov al, [si]
	cmp al, 0
	je db3
	cmp al, ','
	je db3
	call isws
	jc db3
	inc si
	inc cx
	jmp db2
db3:	mov [t1p], bx
	mov [t1l], cx
	call hexchk
	jc db4
	call numchk
	jc db5
	mov ax, mbaddb
	mov [emsg], ax
	jmp erec
db4:	mov bx, celld
	call bstrz
	call hcell
	mov bx, cellde
	call bstrz
	jmp db6
db5:	mov bx, celld
	call bstrz
	mov al, 'n'
	stosb
	mov bx, aeq
	call bstrz
	mov bx, [t1p]
	mov cx, [t1l]
	call bspan
	mov bx, qend
	call bstrz
	mov bx, cellde
	call bstrz
db6:	mov ax, [dbcnt]
	inc ax
	mov [dbcnt], ax
	; separator
	call skipws
	mov al, [si]
	cmp al, 0
	jne db6a
	jmp db9
db6a:	cmp al, ','
	je db7
	mov ax, mcomma
	mov [emsg], ax
	jmp erec
db7:	inc si
	jmp db1
dbstr:	inc si
db10:	mov al, [si]
	cmp al, 0
	jne db11
	mov ax, munterm
	mov [emsg], ax
	jmp erec
db11:	cmp al, 34
	je db12
	mov bx, celld
	call bstrz
	mov al, 'c'
	stosb
	mov bx, aeq
	call bstrz
	mov al, [si]
	call besc
	mov bx, qend
	call bstrz
	mov bx, cellde
	call bstrz
	mov ax, [dbcnt]
	inc ax
	mov [dbcnt], ax
	inc si
	jmp db10
db12:	inc si
	jmp db6
dbchr:	mov al, [si+2]
	cmp al, 39
	je db13
	mov ax, mbadchr
	mov [emsg], ax
	jmp erec
db13:	mov bx, celld
	call bstrz
	mov al, 'c'
	stosb
	mov bx, aeq
	call bstrz
	mov al, [si+1]
	call besc
	mov bx, qend
	call bstrz
	mov bx, cellde
	call bstrz
	add si, 3
	mov ax, [dbcnt]
	inc ax
	mov [dbcnt], ax
	jmp db6
db9:	mov ax, [dbcnt]
	cmp ax, 0
	jne db14
	mov ax, mdbone
	mov [emsg], ax
	jmp erec
db14:	call bfs
	; src
	call emsrc
	ret

; ---- dw ----
dodw:	; parse words into cells; refs may occur -> parse BEFORE header?
	; refs live in fields before attrs/cells, so build cells into abuf.
	mov ax, abuf
	mov [ai], ax
	mov ax, 0
	mov [dbcnt], ax
dw1:	call skipws
	mov al, [si]
	cmp al, 0
	jne dw2
	; end: need at least one word
	mov ax, [dbcnt]
	cmp ax, 0
	je dw1e
	jmp dw9
dw1e:	mov ax, mdwsep
	mov [emsg], ax
	jmp erec
dw2:	mov bx, si
	mov cx, 0
dw3:	mov al, [si]
	cmp al, 0
	je dw4
	cmp al, ','
	je dw4
	call isws
	jc dw4
	inc si
	inc cx
	jmp dw3
dw4:	cmp cx, 0
	jne dw5
	mov ax, mdwsep
	mov [emsg], ax
	jmp erec
dw5:	mov [t1p], bx
	mov [t1l], cx
	call hexchk
	jc dwhex
	call numchk
	jc dwnum
	mov bx, [t1p]
	mov al, [bx]
	call isid0
	jc dwsym
	mov ax, mdwop
	mov [emsg], ax
	jmp erec
dwhex:	mov bx, cellw
	call astrz
	; hex digits into abuf via role-less names: reuse hwireless path
	call acell
	mov bx, cellwe
	call astrz
	jmp dw6
dwnum:	mov bx, cellw
	call astrz
	mov al, 'n'
	call aput
	mov bx, aeq
	call astrz
	mov bx, [t1p]
	mov cx, [t1l]
	call aspan
	mov bx, qend
	call astrz
	mov bx, cellwe
	call astrz
	jmp dw6
dwsym:	mov ax, 'w'
	call refcand
	mov bx, cellw
	call astrz
	mov al, 's'
	call aput
	mov bx, aeq
	call astrz
	mov bx, [t1p]
	mov cx, [t1l]
	call aspan
	mov bx, qend
	call astrz
	mov bx, cellwe
	call astrz
dw6:	mov ax, [dbcnt]
	inc ax
	mov [dbcnt], ax
	call skipws
	mov al, [si]
	cmp al, 0
	jne dw6a
	jmp dw1
dw6a:	cmp al, ','
	je dw7
	mov ax, mdwop
	mov [emsg], ax
	jmp erec
dw7:	inc si
	call skipws
	mov al, [si]
	cmp al, 0
	je dw7e
	jmp dw1
dw7e:	mov ax, mdwsep
	mov [emsg], ax
	jmp erec
dw9:	; emit the record
	mov al, 'w'
	call rhead
	call bfs
	call bfs
	; ref + role
	mov bx, [refp]
	mov cx, [refl]
	call brawsp
	call bfs
	mov ax, [refl]
	cmp ax, 0
	je dw10
	mov ax, [refrl]
	stosb
dw10:	call bfs
	call bfs
	call bfs
	; attrs
	mov al, ' '
	stosb
	mov al, 'k'
	stosb
	mov bx, aeq
	call bstrz
	mov bx, kdw
	call bstrz
	mov bx, qend
	call bstrz
	call bfs
	; cells from abuf
	mov bx, abuf
	mov cx, [ai]
	sub cx, abuf
	call brawsp
	call bfs
	call emsrc
	ret

; hex cell attrs into abuf with plain h1..h4 names (for dw)
acell:	push di
	mov di, [ai]
	call hcell
	mov [ai], di
	pop di
	ret

; emit src field for an item line: label prefix decides raw vs indented
emsrc:	mov ax, [hadlbl]
	cmp ax, 0
	je es1
	call srclbl
	ret
es1:	call srcraw
	ret

; ==== instruction handler ==================================================
; op token at (opp,opl); si after it.
doop:	; reset per-op state and abuf
	mov ax, abuf
	mov [ai], ax
	; rel8 flag
	mov ax, [opp]
	mov [t1p], ax
	mov ax, [opl]
	mov [t1l], ax
	mov bx, reltbl
	call tblchk
	jnc do1
	mov ax, 1
	mov [r8f], ax
do1:	; operands
	call skipws
	mov al, [si]
	cmp al, 0
	je doemit
	mov ax, 'a'
	mov [slotc], ax
	call opparse
	call skipws
	mov al, [si]
	cmp al, 0
	je doemit
	cmp al, ','
	je do2
	mov ax, mbadop
	mov [emsg], ax
	jmp erec
do2:	inc si
	call skipws
	mov ax, 'b'
	mov [slotc], ax
	call opparse
	call skipws
	mov al, [si]
	cmp al, 0
	je doemit
	cmp al, ','
	jne do3
	mov ax, mtwoop
	mov [emsg], ax
	jmp erec
do3:	mov ax, mbadop
	mov [emsg], ax
	jmp erec

doemit:	mov al, 'o'
	call rhead
	; name, n empty
	call bfs
	call bfs
	; ref
	mov bx, [refp]
	mov cx, [refl]
	call brawsp
	call bfs
	mov ax, [refl]
	cmp ax, 0
	je de1
	mov ax, [refrl]
	stosb
de1:	call bfs
	; r8
	mov ax, [r8f]
	cmp ax, 0
	je de2
	mov al, '1'
	stosb
de2:	call bfs
	; atarget
	mov bx, [atgp]
	mov cx, [atgl]
	call brawsp
	call bfs
	; attrs: k, op, then everything accumulated in abuf, then suffixes
	mov al, ' '
	stosb
	mov al, 'k'
	stosb
	mov bx, aeq
	call bstrz
	mov bx, kop
	call bstrz
	mov bx, qend
	call bstrz
	mov al, ' '
	stosb
	mov al, 'o'
	stosb
	mov al, 'p'
	stosb
	mov bx, aeq
	call bstrz
	mov bx, [opp]
	mov cx, [opl]
	call bspan
	mov bx, qend
	call bstrz
	mov bx, abuf
	mov cx, [ai]
	sub cx, abuf
	call brawsp
	; sz
	mov ax, [szv]
	cmp ax, 0
	je de3
	mov al, ' '
	stosb
	mov al, 's'
	stosb
	mov al, 'z'
	stosb
	mov bx, aeq
	call bstrz
	mov ax, [szv]
	mov bx, sztbl
de3a:	dec ax
	cmp ax, 0
	je de3b
	push ax
	mov al, [bx]
	mov ah, 0
	add bx, ax
	inc bx
	pop ax
	jmp de3a
de3b:	mov al, [bx]
	mov ah, 0
	mov cx, ax
	inc bx
de3c:	mov al, [bx]
	stosb
	inc bx
	dec cx
	jne de3c
	mov bx, qend
	call bstrz
de3:	; mseg
	mov ax, [msegv]
	cmp ax, 0
	je de4
	mov al, ' '
	stosb
	mov al, 'm'
	stosb
	mov al, 's'
	stosb
	mov al, 'e'
	stosb
	mov al, 'g'
	stosb
	mov bx, aeq
	call bstrz
	mov ax, [msegv]
	dec ax
	add ax, ax
	mov bx, segtbl
	add bx, ax
	mov al, [bx]
	stosb
	mov al, [bx+1]
	stosb
	mov bx, qend
	call bstrz
de4:	; lock
	mov ax, [lockf]
	cmp ax, 0
	je de5
	mov bx, alock
	call bstrz
de5:	; far pointer: fseg/foff attrs + wires
	mov ax, [farfl]
	cmp ax, 0
	jne de5a
	jmp de7
de5a:	mov al, ' '
	stosb
	mov al, 'f'
	stosb
	mov al, 's'
	stosb
	mov al, 'e'
	stosb
	mov al, 'g'
	stosb
	mov bx, aeq
	call bstrz
	mov bx, [fsp]
	mov cx, [fsl]
	call bspan
	mov bx, qend
	call bstrz
	mov al, ' '
	stosb
	mov al, 'f'
	stosb
	mov al, 'o'
	stosb
	mov al, 'f'
	stosb
	mov al, 'f'
	stosb
	mov bx, aeq
	call bstrz
	mov bx, [fop]
	mov cx, [fol]
	call bspan
	mov bx, qend
	call bstrz
	; hex wires for numeric halves ride role wires a (seg) and b (off)
	mov ax, abuf
	mov [ai], ax
	mov ax, [fsp]
	mov [t1p], ax
	mov ax, [fsl]
	mov [t1l], ax
	call hexchk
	jnc de6
	mov dx, 'a'
	call hwire
de6:	mov ax, [fop]
	mov [t1p], ax
	mov ax, [fol]
	mov [t1l], ax
	call hexchk
	jnc de6a
	mov dx, 'b'
	call hwire
de6a:	mov bx, abuf
	mov cx, [ai]
	sub cx, abuf
	call brawsp
de7:	call bfs
	; cells empty for op
	call bfs
	call emsrc
	ret

; ==== org / pad / equ ======================================================
; org|pad arg at (t1p,t1l) already validated decimal. kind char in al.
dorgpad:
	push ax
	call rhead
	call bfs
	; n field
	mov bx, [t1p]
	mov cx, [t1l]
	call brawsp
	call bfs
	call bfs
	call bfs
	call bfs
	call bfs
	; attrs
	mov al, ' '
	stosb
	mov al, 'k'
	stosb
	mov bx, aeq
	call bstrz
	pop ax
	cmp al, 'g'
	jne dp1
	mov bx, korg
	call bstrz
	mov bx, qend
	call bstrz
	mov bx, aan
	call bstrz
	mov bx, [t1p]
	mov cx, [t1l]
	call bspan
	mov bx, qend
	call bstrz
	jmp dp2
dp1:	mov bx, kpad
	call bstrz
	mov bx, qend
	call bstrz
dp2:	call bfs
	call bfs
	call emsrc
	ret

; ==== the main line loop ===================================================
main:	cld
	mov sp, spbase
	mov di, obuf
	; preprocess: \r\n -> 2,0 ; \n -> 0 ; stop at 255
	mov si, src
pp1:	mov al, [si]
	cmp al, 255
	je pp9
	cmp al, 13
	jne pp2
	mov al, [si+1]
	cmp al, 10
	jne pp3
	mov al, 2
	mov [si], al
	inc si
	mov al, 0
	mov [si], al
	inc si
	jmp pp1
pp2:	cmp al, 10
	jne pp3
	mov al, 0
	mov [si], al
pp3:	inc si
	jmp pp1
pp9:	mov si, src

; ---- per line -------------------------------------------------------------
lloop:	mov sp, spbase
	mov ax, [lineno]
	inc ax
	mov [lineno], ax
	mov [lstart], si
	mov ax, 0
	mov [hadlbl], ax
	mov [cmtp], ax
	mov [szv], ax
	mov [msegv], ax
	mov [lockf], ax
	mov [memc], ax
	mov [chrc], ax
	mov [refl], ax
	mov [refp], ax
	mov [refrl], ax
	mov [atgl], ax
	mov [atgp], ax
	mov [r8f], ax
	mov [farfl], ax
	mov ax, abuf
	mov [ai], ax
	; find line end + first unquoted ';'
	mov bx, si
	mov dx, 0
ls1:	mov al, [bx]
	cmp al, 0
	je ls9
	cmp al, 2
	je ls9
	cmp al, 255
	je ls9
	cmp dx, 0
	jne ls3
	cmp al, ';'
	jne ls2
	mov ax, [cmtp]
	cmp ax, 0
	jne ls4
	mov [cmtp], bx
	jmp ls4
ls2:	cmp al, 34
	je lsq
	cmp al, 39
	je lsq
	jmp ls4
lsq:	mov dl, al
	mov dh, 0
	jmp ls4
ls3:	; inside a quote: only the matching quote closes it
	cmp al, dl
	jne ls4
	mov dx, 0
ls4:	inc bx
	jmp ls1
ls9:	mov [lend], bx
	mov al, [bx]
	mov ah, 0
	mov [lendm], ax
	; the parse view is a C string: the terminator (whatever it was) is
	; zeroed; the advance logic only consults [lendm]
	mov al, 0
	mov [bx], al
	; cut the comment for parsing
	mov ax, [cmtp]
	cmp ax, 0
	je ls10
	mov bx, ax
	mov al, [bx]
	mov ah, 0
	mov [cmtch], ax
	mov al, 0
	mov [bx], al
ls10:	call skipws
	; label?
	mov ax, si
	mov [savsi], ax
	call identsc
	cmp cx, 0
	jne llb1
	jmp lnolbl
llb1:	mov al, [si]
	cmp al, ':'
	je llb2
	jmp lnolbl
llb2:	inc si
	; emit lbl record: peek whether rest is empty for the src flavor
	mov [t1p], bx
	mov [t1l], cx
	call skipws
	mov ax, si
	mov [savp], ax
	mov al, 'l'
	call rhead
	; name field
	mov bx, [t1p]
	mov cx, [t1l]
	call brawsp
	call bfs
	call bfs
	call bfs
	call bfs
	call bfs
	call bfs
	; attrs: k="lbl" name="X"
	mov al, ' '
	stosb
	mov al, 'k'
	stosb
	mov bx, aeq
	call bstrz
	mov bx, klbl
	call bstrz
	mov bx, qend
	call bstrz
	mov bx, aname
	call bstrz
	mov bx, [t1p]
	mov cx, [t1l]
	call bspan
	mov bx, qend
	call bstrz
	call bfs
	call bfs
	; src: "name:" if more follows, else the raw line
	mov bx, [savp]
	mov al, [bx]
	cmp al, 0
	je llraw
	mov bx, [t1p]
	mov cx, [t1l]
	call bspan
	mov al, ':'
	stosb
	call bnl
	call flush
	mov ax, 1
	mov [hadlbl], ax
	jmp lrest0
llraw:	call srcraw
	jmp lnext
lnolbl:	mov ax, [savsi]
	mov si, ax
lrest0:	call skipws
	mov al, [si]
	cmp al, 0
	je lbl0
	jmp lhave
lbl0:	; blank (unless a label already owned the line)
	mov ax, [hadlbl]
	cmp ax, 0
	je lbl1
	jmp lnext
lbl1:	mov al, 'b'
	call rhead
	call bfs
	call bfs
	call bfs
	call bfs
	call bfs
	call bfs
	mov al, ' '
	stosb
	mov al, 'k'
	stosb
	mov bx, aeq
	call bstrz
	mov bx, kblank
	call bstrz
	mov bx, qend
	call bstrz
	call bfs
	call bfs
	call srcraw
	jmp lnext

lhave:	; equ?  ident ws 'equ' ws value eol
	mov ax, si
	mov [savsi], ax
	call identsc
	cmp cx, 0
	jne leq0
lneq0:	jmp lnoequ
leq0:	mov [t1p], bx
	mov [t1l], cx
	mov al, [si]
	call isws
	jnc lneq0
	mov ax, [t1p]
	mov [c1p], ax
	mov ax, [t1l]
	mov [c1l], ax
	call skipws
	call identsc
	cmp cx, 3
	jne lneq0
	mov al, [bx]
	call lower
	cmp al, 'e'
	jne lneq0
	mov al, [bx+1]
	call lower
	cmp al, 'q'
	jne lneq0
	mov al, [bx+2]
	call lower
	cmp al, 'u'
	jne lneq0
	mov al, [si]
	call isws
	jnc lneq0
	call skipws
	; value token: to whitespace/eol
	mov bx, si
	mov cx, 0
lq1:	mov al, [si]
	cmp al, 0
	je lq2
	call isws
	jc lq2
	inc si
	inc cx
	jmp lq1
lq2:	cmp cx, 0
	jne lq3
	mov ax, mequv
	mov [emsg], ax
	jmp erec
lq3:	mov [eqvp], bx
	mov [eqvl], cx
	call skipws
	mov al, [si]
	cmp al, 0
	je lq4
	jmp lnoequ
lq4:	; emit the equ record
	mov al, 'e'
	call rhead
	mov bx, [c1p]
	mov cx, [c1l]
	call brawsp
	call bfs
	call bfs
	call bfs
	call bfs
	call bfs
	call bfs
	; attrs
	mov al, ' '
	stosb
	mov al, 'k'
	stosb
	mov bx, aeq
	call bstrz
	mov bx, kequ
	call bstrz
	mov bx, qend
	call bstrz
	mov bx, aname
	call bstrz
	mov bx, [c1p]
	mov cx, [c1l]
	call bspan
	mov bx, qend
	call bstrz
	; value: decimal n / hex h-wires / char c
	mov ax, [eqvp]
	mov [t1p], ax
	mov ax, [eqvl]
	mov [t1l], ax
	call numchk
	jnc lq5
	mov bx, aan
	call bstrz
	mov bx, [t1p]
	mov cx, [t1l]
	call bspan
	mov bx, qend
	call bstrz
	jmp lq8
lq5:	call hexchk
	jnc lq6
	mov al, ' '
	stosb
	call hcell
	jmp lq8
lq6:	; char literal?
	mov ax, [eqvl]
	cmp ax, 3
	jne lq7
	mov bx, [t1p]
	mov al, [bx]
	cmp al, 39
	jne lq7
	mov al, [bx+2]
	cmp al, 39
	jne lq7
	mov al, ' '
	stosb
	mov al, 'c'
	stosb
	mov bx, aeq
	call bstrz
	mov bx, [t1p]
	mov al, [bx+1]
	call besc
	mov bx, qend
	call bstrz
	jmp lq8
lq7:	mov ax, mequv
	mov [emsg], ax
	jmp erec
lq8:	call bfs
	call bfs
	call emsrc
	jmp lnext

lnoequ:	mov ax, [savsi]
	mov si, ax
	; op token
	mov bx, si
	mov cx, 0
lt1:	mov al, [si]
	cmp al, 0
	je lt2
	call isws
	jc lt2
	inc si
	inc cx
	jmp lt1
lt2:	mov [opp], bx
	mov [opl], cx
	; keyword dispatch on the lowered token
	mov ax, cx
	cmp ax, 2
	jne lt5
	mov al, [bx]
	call lower
	mov dl, al
	mov al, [bx+1]
	call lower
	mov dh, al
	cmp dl, 'd'
	jne lt5
	cmp dh, 'b'
	jne lt3
	call dodb
	jmp lnext
lt3:	cmp dh, 'w'
	jne lt5
	call dodw
	jmp lnext
lt5:	mov ax, [opl]
	cmp ax, 3
	je lt5x
	jmp lt8
lt5x:	mov bx, [opp]
	mov al, [bx]
	call lower
	mov dl, al
	mov al, [bx+1]
	call lower
	mov dh, al
	mov al, [bx+2]
	call lower
	cmp dl, 'o'
	jne lt6
	cmp dh, 'r'
	jne lt6
	cmp al, 'g'
	jne lt6
	call dorgarg
	; org bookkeeping
	mov ax, [orgsn]
	cmp ax, 0
	je lt5a
	mov ax, morg1
	mov [emsg], ax
	jmp erec
lt5a:	mov ax, [codesn]
	cmp ax, 0
	je lt5b
	mov ax, morg2
	mov [emsg], ax
	jmp erec
lt5b:	mov ax, 1
	mov [orgsn], ax
	mov al, 'g'
	call dorgpad
	jmp lnext
lt6:	cmp dl, 'p'
	jne lt6x
	cmp dh, 'a'
	jne lt6x
	cmp al, 'd'
	jne lt6x
	jmp lt6y
lt6x:	jmp lt8
lt6y:
	call dpadarg
	mov ax, [padsn]
	cmp ax, 0
	je lt7
	mov ax, mpad1
	mov [emsg], ax
	jmp erec
lt7:	mov ax, 1
	mov [padsn], ax
	mov ax, 1
	mov [codesn], ax
	mov al, 'p'
	call dorgpad
	jmp lnext
lt8:	; lock prefix?
	mov ax, [opl]
	cmp ax, 4
	jne lt9
	mov bx, [opp]
	mov al, [bx]
	call lower
	cmp al, 'l'
	jne lt9
	mov al, [bx+1]
	call lower
	cmp al, 'o'
	jne lt9
	mov al, [bx+2]
	call lower
	cmp al, 'c'
	jne lt9
	mov al, [bx+3]
	call lower
	cmp al, 'k'
	jne lt9
	mov ax, 1
	mov [lockf], ax
	call skipws
	mov al, [si]
	cmp al, 0
	jne lt8a
	mov ax, mlock
	mov [emsg], ax
	jmp erec
lt8a:	; re-scan the real op token
	mov bx, si
	mov cx, 0
lt8b:	mov al, [si]
	cmp al, 0
	je lt8c
	call isws
	jc lt8c
	inc si
	inc cx
	jmp lt8b
lt8c:	mov [opp], bx
	mov [opl], cx
lt9:	mov ax, 1
	mov [codesn], ax
	call doop
	jmp lnext

; org/pad argument: single decimal token to end of line -> (t1p,t1l)
dorgarg: call skipws
	mov bx, si
	mov cx, 0
lo1:	mov al, [si]
	cmp al, 0
	je lo2
	call isws
	jc lo2
	inc si
	inc cx
	jmp lo1
lo2:	mov [t1p], bx
	mov [t1l], cx
	call numchk
	jnc lo3
	call skipws
	mov al, [si]
	cmp al, 0
	jne lo3
	ret
lo3:	mov ax, morgn
	mov [emsg], ax
	jmp erec
dpadarg: call skipws
	mov bx, si
	mov cx, 0
lp1:	mov al, [si]
	cmp al, 0
	je lp2
	call isws
	jc lp2
	inc si
	inc cx
	jmp lp1
lp2:	mov [t1p], bx
	mov [t1l], cx
	call numchk
	jnc lp3
	call skipws
	mov al, [si]
	cmp al, 0
	jne lp3
	ret
lp3:	mov ax, mpadn
	mov [emsg], ax
	jmp erec

; ---- restore + advance ----------------------------------------------------
lrest:	; error path lands here too (stack already reset)
lnext:	mov ax, [cmtp]
	cmp ax, 0
	je ln1
	mov bx, ax
	mov ax, [cmtch]
	mov [bx], al
ln1:	mov si, [lend]
	mov ax, [lendm]
	cmp ax, 255
	je ldone
	cmp ax, 2
	jne ln2
	add si, 2
	jmp lloop
ln2:	inc si
	jmp lloop

; ---- end of input ---------------------------------------------------------
ldone:	mov ax, [orgsn]
	cmp ax, 0
	jne lfin
	; implicit org 256, item index 0, line 0
	mov al, 'I'
	stosb
	call bfs
	mov al, '0'
	stosb
	call bfs
	mov al, '0'
	stosb
	call bfs
	mov al, 'g'
	stosb
	call bfs
	call bfs
	mov bx, n256
	call bstrz
	call bfs
	call bfs
	call bfs
	call bfs
	call bfs
	mov al, ' '
	stosb
	mov al, 'k'
	stosb
	mov bx, aeq
	call bstrz
	mov bx, korg
	call bstrz
	mov bx, qend
	call bstrz
	mov bx, aan
	call bstrz
	mov bx, n256
	call bstrz
	mov bx, qend
	call bstrz
	call bfs
	call bfs
	mov bx, sorgimp
	call bstrz
	call bnl
	call flush
lfin:	mov ax, 0x4c00
	int 0x21
src:
