#pragma warning(disable : 4996)
#ifndef U8TYPEDEF_H
#define U8TYPEDEF_H

#define TOKEN_LEN 36

typedef unsigned char byte;
typedef int state;
typedef int mode;
typedef unsigned int clock;
typedef unsigned int uint;
typedef unsigned short word;
typedef long long int i64;
typedef struct
{
	byte mem[256];
	byte reg[7];
	byte tag;
	clock t;
}U8VM;
typedef struct
{
	char token[236][3][TOKEN_LEN];
	byte line_count;
	byte error[236];
	word line[236];
}U8toktab;
typedef struct
{
	byte ins[236];
	byte ins_count;
	byte data[236];
	byte data_len;
	word error_line[236];
	byte error_count;
}U8ins;

typedef union
{
	byte b;
	word w;
	uint d;
}dword;

#define PRIVATE static

#define ERROR	-1
#define SUCCESS	0
#define NOTHING	1

#define RUNNING	1
#define HALT	0

#define A	vm->reg[0]
#define B	vm->reg[1]
#define X	vm->reg[2]
#define Y	vm->reg[3]
#define PC	vm->reg[4]
#define SP	vm->reg[5]
#define CCR vm->reg[6]

#define REG		vm->reg
#define MEM		vm->mem
#define TIME	vm->t
#define TAG		vm->tag

#define SET_BIT(val, n)    ((val) |=  (1U << (n)))
#define CLR_BIT(val, n)    ((val) &= ~(1U << (n)))
#define TOGGLE_BIT(val, n) ((val) ^=  (1U << (n)))
#define READ_BIT(val, n)   (((val) >> (n)) & 1U)
#define GET_BITS(val, high, low) \
    (((val) >> (low)) & ((1U << ((high) - (low) + 1)) - 1))
#define BIT_MASK(high, low) \
    (((1U << ((high) - (low) + 1)) - 1U) << (low))
#define SET_BITS(val, high, low, newval)                  \
        (val) = ((val) & ~BIT_MASK(high, low)) |          \
                (((newval) << (low)) & BIT_MASK(high, low))

#define CMD GET_BITS(MEM[PC],7,4)
#define R1	GET_BITS(MEM[PC],3,2)
#define R2	GET_BITS(MEM[PC],1,0)
#define IMM GET_BITS(MEM[PC],3,0)

#define ZF_S SET_BIT(CCR,0)
#define ZF_C CLR_BIT(CCR,0)
#define CF_S SET_BIT(CCR,1)
#define CF_C CLR_BIT(CCR,1)
#define PF_S SET_BIT(CCR,2)
#define PF_C CLR_BIT(CCR,2)
#define EF_S SET_BIT(CCR,3)
#define EF_C CLR_BIT(CCR,3)
#define TF_S SET_BIT(CCR,4)
#define TF_C CLR_BIT(CCR,4)

#define GOTO	0
#define Z		1
#define NZ		2
#define C		3
#define NC		4
#define P		5
#define NP		6
#define T		7
#define NT		8
#define E		9
#define NE		10
#define GT		11
#define LT		12
#define GE		13
#define LE		14
#define NOP		15

#define ZF READ_BIT(CCR,0)
#define CF READ_BIT(CCR,1)
#define PF READ_BIT(CCR,2)
#define EF READ_BIT(CCR,3)
#define TF READ_BIT(CCR,4)

#define OR		0
#define AND		1
#define INH		2
#define IMP		3
#define XOR		4
#define NOR		5
#define XNOR	6
#define NAND	7
#define LSH		8
#define RSH		9
#define RLS		10
#define RRS		11
#define ADD		12
#define SUB		13
#define MUL		14
#define DIV		15

#define INC		0
#define DEC		1
#define NOT		2
#define ZERO	3

#define REV		0
#define POPCNT	1
#define CLZ		2
#define CTZ		3

#define MOV		0
#define LDM		1
#define SVM		2
#define LAH		3
#define LAL		4
#define LXH		5
#define LXL		6
#define JMP		7
#define ALU		8
#define PUSH	9
#define POP		10
#define CALL	11
#define RET		12
#define QOP1	13
#define QOP2	14
#define HLT		15
//0b00000100
#define ONCE    4
//0b00000001
#define STEP    1
//0b00000010
#define ECHO    2
#define DEFAULT STEP | ECHO

#define TRUE	1
#define FALSE	0

#define REG_A	0
#define REG_B	1
#define REG_X	2
#define REG_Y	3

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <ctype.h>
#include <errno.h>

#ifdef _WIN32
#include <conio.h>
#else
#include <termios.h>
#include <unistd.h>
#endif

int get_key_press(void);
void press_any_key_to_continue(const char* message);

#endif
