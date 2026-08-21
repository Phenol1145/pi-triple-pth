#include "U8VM.h"
state U8_Initialize(U8VM* vm,byte reg[7])
{
	if (!vm) return ERROR;
	memset(MEM, 0, sizeof(MEM));
	TIME = 0;
	TAG = RUNNING;
	if (reg)
	{
		vm->reg[0] = reg[0];
		vm->reg[1] = reg[1];
		vm->reg[2] = reg[2];
		vm->reg[3] = reg[3];
		vm->reg[4] = reg[4];
		vm->reg[5] = reg[5];
		vm->reg[6] = reg[6];
	}
	else
	{
		A = B = X = Y = CCR = 0;
		PC = 0x10;
		SP = 0xff;
	}
	return SUCCESS;
}

state U8_LoadProgramme(U8VM* vm, byte* prog, rsize_t psz)
{
	if (!vm || !prog)return ERROR;
	memcpy(MEM + 16, prog, psz);
	return SUCCESS;
}

PRIVATE void step_mov(U8VM* vm)
{
	int r1 = R1;
	REG[r1] = REG[R2];
	if (REG[r1] == 0)ZF_S; else ZF_C;
	CF_C;
	if (READ_BIT(REG[r1], 0))PF_S; else PF_C;
	EF_C;
	PC++;
	TIME++;
}

PRIVATE void step_ldm(U8VM* vm)
{
	int r = R2;
	REG[r] = MEM[X];
	if (REG[r] == 0)ZF_S; else ZF_C;
	CF_C;
	if (READ_BIT(REG[r], 0))PF_S; else PF_C;
	EF_C;
	PC++;
	TIME++;
}

PRIVATE void step_svm(U8VM* vm)
{
	MEM[X] = REG[R2];
	PC++;
	TIME++;
}

PRIVATE void step_lah(U8VM* vm)
{
	SET_BITS(A, 7, 4, IMM);
	PC++;
	TIME++;
}

PRIVATE void step_lal(U8VM* vm)
{
	SET_BITS(A, 3, 0, IMM);
	PC++;
	TIME++;
}

PRIVATE void step_lxh(U8VM* vm)
{
	SET_BITS(X, 7, 4, IMM);
	PC++;
	TIME++;
}

PRIVATE void step_lxl(U8VM* vm)
{
	SET_BITS(X, 3, 0, IMM);
	PC++;
	TIME++;
}

PRIVATE void step_jmp(U8VM* vm)
{
	TIME++;
	switch (IMM)
	{
	case GOTO:
		goto DO_JMP;
	case Z:
		if (ZF)goto DO_JMP;
		else goto NO_JMP;
	case NZ:
		if (ZF)goto NO_JMP;
		else goto DO_JMP;
	case C:
		if (CF)goto DO_JMP;
		else goto NO_JMP;
	case NC:
		if (CF)goto NO_JMP;
		else goto DO_JMP;
	case P:
		if (PF)goto DO_JMP;
		else goto NO_JMP;
	case NP:
		if (PF)goto NO_JMP;
		else goto DO_JMP;
	case T:
		if (TF)goto DO_JMP;
		else goto NO_JMP;
	case NT:
		if (TF)goto NO_JMP;
		else goto DO_JMP;
	case E:
		if (EF)goto DO_JMP;
		else goto NO_JMP;
	case NE:
		if (EF)goto NO_JMP;
		else goto DO_JMP;
	case GT:
		if (ZF || CF)goto NO_JMP;
		else goto DO_JMP;
	case GE:
		goto NO_JMP;
	case LT:
		if (!ZF && CF)goto DO_JMP;
		else goto NO_JMP;
	case LE:
		goto NO_JMP;
	case NOP:
		goto NO_JMP;
	}
DO_JMP:
	PC = X;
	return;
NO_JMP:
	PC++;
	return;
}

PRIVATE void step_alu(U8VM* vm)
{
	byte temp;
	uint usum;
	int isum;
	PC++;
	TIME++;
	switch (IMM)
	{
	case OR:
		A = A | B;
		goto SET_FLAGS;
	case AND:
		A = A & B;
		goto SET_FLAGS;
	case INH:
		A = (~A) & B;
		goto SET_FLAGS;
	case IMP:
		A = A | (byte)(~B);
		goto SET_FLAGS;
	case XOR:
		A = A ^ B;
		goto SET_FLAGS;
	case NOR:
		A = (byte)~(A | B);
		goto SET_FLAGS;
	case XNOR:
		A = (byte)~(A ^ B);
		goto SET_FLAGS;
	case NAND:
		A = (byte)~(A & B);
		goto SET_FLAGS;
	case LSH:
		if (B > 8u)
		{
			A = 0;
			CF_C;
			ZF_S;
			PF_C;
			EF_S;
		}
		else if (B == 8u)
		{
			if (READ_BIT(A, 0))CF_S; else CF_C;
			ZF_S;
			PF_C;
			EF_S;
			A = 0;
		}
		else if (B == 0u) goto SET_FLAGS;
		else
		{
			if (READ_BIT(A, (byte)8 - B))CF_S; else CF_C;
			A = (byte)(A << B);
			if (A == 0u)ZF_S; else ZF_C;
			if (READ_BIT(A, 0))PF_S; else PF_C;
			EF_C;
		}
		break;
	case RSH:
		if (B > 8u)
		{
			A = 0;
			CF_C;
			ZF_S;
			PF_C;
			EF_S;
		}
		else if (B == 8u)
		{
			if (READ_BIT(A, 7))CF_S; else CF_C;
			ZF_S;
			PF_C;
			EF_S;
			A = 0;
		}
		else if (B == 0u) goto SET_FLAGS;
		else
		{
			if (READ_BIT(A, B - (byte)1))CF_S; else CF_C;
			A = A >> B;
			if (A == 0u)ZF_S; else ZF_C;
			if (READ_BIT(A, 0))PF_S; else PF_C;
			EF_C;
		}
		break;
	case RLS:
		temp = B % 8;
		A = (byte)(A << temp) | (byte)(A >> ((byte)8 - temp));
		goto SET_FLAGS;
	case RRS:
		temp = B % 8;
		A = (byte)(A >> temp) | (byte)(A << ((byte)8 - temp));
		goto SET_FLAGS;
	case ADD:
		usum = (uint)A + (uint)B;
		if (usum > 255u)
		{
			CF_S;
			usum -= 256u;
		}
		else CF_C;
		A = (byte)usum;
		if (A == 0u)ZF_S; else ZF_C;
		if (READ_BIT(A, 0))PF_S; else PF_C;
		EF_C;
		break;
	case SUB:
		isum = (int)A - (int)B;
		if (isum < 0)
		{
			CF_S;
			isum += 256;
		}
		else CF_C;
		A = (byte)isum;
		if (A == 0u)ZF_S; else ZF_C;
		if (READ_BIT(A, 0))PF_S; else PF_C;
		EF_C;
		break;
	case MUL:
		usum = (uint)A * (uint)B;
		A = (byte)(usum >> 8u);
		B = (byte)usum;
		usum == 0u ? ZF_S : ZF_C;
		if (usum == 0u)ZF_S; else ZF_C;
		if (A)CF_S; else CF_C;
		if (READ_BIT(B, 0))PF_S; else PF_C;
		EF_C;
		break;
	case DIV:
		if (B)
		{
			temp = A % B;
			A = A / B;
			B = temp;
			if (A == 0u)ZF_S; else ZF_C;
			if (temp == 0u)CF_S; else CF_C;
			if (READ_BIT(A, 0))PF_S; else PF_C;
			EF_C;
		}
		else
		{
			A = 255u;
			CF_S;
			ZF_C;
			PF_S;
			EF_S;
		}
		break;
	}
SET_FLAGS:
	if (A == 0u)ZF_S; else ZF_C;
	if (READ_BIT(A, 0))PF_S; else PF_C;
	CF_C;
	EF_C;
}

PRIVATE void step_push(U8VM* vm)
{
	MEM[SP--] = REG[R2];
	PC++;
	TIME++;
}

PRIVATE void step_pop(U8VM* vm)
{
	int r = R2;
	REG[r] = MEM[++SP];
	if (REG[r] == 0u)ZF_S; else ZF_C;
	CF_C;
	if (READ_BIT(REG[r], 0))PF_S; else PF_C;
	EF_C;
	PC++;
	TIME++;
}

PRIVATE void step_call(U8VM* vm)
{
	MEM[SP--] = A;
	MEM[SP--] = B;
	MEM[SP--] = Y;
	MEM[SP--] = PC;
	PC = X;
	TIME++;
}

PRIVATE void step_ret(U8VM* vm)
{
	PC = MEM[++SP];
	Y = MEM[++SP];
	B = MEM[++SP];
	A = MEM[++SP];
	TIME++;
}

PRIVATE void step_qop1(U8VM* vm)
{
	int r = R2;
	PC++;
	TIME++;
	EF_C;
	switch (R1)
	{
	case INC:
		if (REG[r] == 255u)
		{
			CF_S;
			ZF_S;
			PF_C;
			REG[r] = 0;
		}
		else
		{
			CF_C;
			ZF_C;
			REG[r]++;
			if (READ_BIT(REG[r], 0))PF_S; else PF_C;
		}
		break;
	case DEC:
		if (REG[r] == 0u)
		{
			CF_S;
			ZF_C;
			PF_S;
			REG[r] = 255;
		}
		else
		{
			CF_C;
			REG[r]--;
			if (REG[r] == 0u)ZF_S; else ZF_C;
			if (READ_BIT(REG[r], 0))PF_S; else PF_C;
		}
		break;
	case NOT:
		REG[r] = (byte)~REG[r];
		CF_C;
		if (REG[r] == 0u)ZF_S; else ZF_C;
		if (READ_BIT(REG[r], 0))PF_S; else PF_C;
		break;
	case ZERO:
		REG[r] = 0;
		CF_C;
		ZF_S;
		PF_C;
		break;
	}
}

PRIVATE void step_qop2(U8VM* vm)
{
	int op = R1, r = R2;
	byte n;
	PC++;
	TIME++;
	CF_C;
	EF_C;
	switch (op)
	{
	case REV:
		REG[r] = (byte)((REG[r] & 0xAA) >> 1) | (byte)((REG[r] & 0x55) << 1);
		REG[r] = (byte)((REG[r] & 0xCC) >> 2) | (byte)((REG[r] & 0x33) << 2);
		REG[r] = (byte)((REG[r] & 0xF0) >> 4) | (byte)((REG[r] & 0x0F) << 4);
		break;
	case POPCNT:
		REG[r] = (REG[r] & 0x55) + ((REG[r] >> 1) & 0x55);
		REG[r] = (REG[r] & 0x33) + ((REG[r] >> 2) & 0x33);
		REG[r] = (REG[r] & 0x0F) + ((REG[r] >> 4) & 0x0F);
		break;
	case CLZ:
		if (REG[r] == 0u)
		{
			REG[r] = 8;
			break;
		}
		n = 0;
		if ((REG[r] & 0xF0) == 0u)
		{
			n += 4;
			REG[r] <<= 4;
		}
		if ((REG[r] & 0xC0) == 0u)
		{
			n += 2;
			REG[r] <<= 2;
		}
		if ((REG[r] & 0x80) == 0u)n++;
		REG[r] = n;
		break;
	case CTZ:
		if (REG[r] == 0u)
		{
			REG[r] = 8;
			break;
		}
		n = 0;
		if ((REG[r] & 0x0F) == 0u)
		{
			n += 4;
			REG[r] >>= 4;
		}
		if ((REG[r] & 0x03) == 0u)
		{
			n += 2;
			REG[r] >>= 2;
		}
		if ((REG[r] & 0x01) == 0u)n++;
		REG[r] = n;
		break;
	}
	if (REG[r] == 0u)ZF_S; else ZF_C;
	if (READ_BIT(REG[r], 0))PF_S; else PF_C;
}

PRIVATE void step_hlt(U8VM* vm)
{
	TAG = HALT;
}

PRIVATE void U8_step(U8VM* vm)
{
	switch (CMD)
	{
	case MOV:
		step_mov(vm);
		break;
	case LDM:
		step_ldm(vm);
		break;
	case SVM:
		step_svm(vm);
		break;
	case LAH:
		step_lah(vm);
		break;
	case LAL:
		step_lal(vm);
		break;
	case LXH:
		step_lxh(vm);
		break;
	case LXL:
		step_lxl(vm);
		break;
	case JMP:
		step_jmp(vm);
		break;
	case ALU:
		step_alu(vm);
		break;
	case PUSH:
		step_push(vm);
		break;
	case POP:
		step_pop(vm);
		break;
	case CALL:
		step_call(vm);
		break;
	case RET:
		step_ret(vm);
		break;
	case QOP1:
		step_qop1(vm);
		break;
	case QOP2:
		step_qop2(vm);
		break;
	case HLT:
		step_hlt(vm);
		break;
	}
}

state U8_Step(U8VM* vm)
{
	if (!vm)return ERROR;
	if (vm->tag == HALT)return SUCCESS;
	U8_step(vm);
	return SUCCESS;
}

PRIVATE state U8_printt(U8VM* vm)
{
	switch (TAG)
	{
	case RUNNING:
		puts("Machine is running.");
		break;
	case HALT:
		puts("Machine is halted.");
		break;
	default:
		puts("Unknown state!");
		return ERROR;
	}
	return SUCCESS;
}

PRIVATE void U8_printc(U8VM* vm)
{
	printf("Clock:%u\n", TIME);
}

PRIVATE void U8_printr(U8VM* vm)
{
	printf(
		"\
%-5s:0x%02X %-5s:0x%02X %-5s:0x%02X %-5s:0x%02X %-5s:0x%02X %-5s:0x%02X\n\
%s:%u %s:%u %s:%u %s:%u %s:%u\n",
"A", A, "B", B, "X", X, "Y", Y, "PC", PC, "SP", SP,
"ZF", ZF, "CF", CF, "PF", PF, "EF", EF, "TF", TF);
}

PRIVATE void U8_printm(U8VM* vm)
{
	int i, j;
	for (i = 0; i < 16; i++)
	{
		printf("%X: ", (unsigned)i);
		for (j = 0; j < 16; j++)
			printf("%02X ", MEM[16 * i + j]);
		puts("");
	}
}

PRIVATE state U8_print(U8VM* vm)
{
	if (U8_printt(vm))return ERROR;
	U8_printc(vm);
	U8_printr(vm);
	U8_printm(vm);
	return SUCCESS;
}

state U8_Print(U8VM* vm, const char* format)
{
	int i = 0;
	if (!vm)return ERROR;
	if (!format || format[0] == '\0') return U8_print(vm);
	while (format[i] != '\0')
	{
		switch (format[i])
		{
		case 't':
		case 'T':
			if (U8_printt(vm))return ERROR;
			break;
		case 'c':
		case 'C':
			U8_printc(vm);
			break;
		case 'r':
		case 'R':
			U8_printr(vm);
			break;
		case 'm':
		case 'M':
			U8_printm(vm);
			break;
		default:
			return ERROR;
		}
		i++;
	}
	return SUCCESS;
}

state U8_Run(U8VM* vm, mode m)
{
	int do_step = (int)READ_BIT((unsigned)m, 0u),
		do_echo = (int)READ_BIT((unsigned)m, 1u),
		do_once = (int)READ_BIT((unsigned)m, 2u);
	state temp;
	if (!vm)return ERROR;
	if (TAG == HALT)return SUCCESS;
	if (do_once)
	{
		U8_step(vm);
		if (do_echo)
		{
			temp = U8_print(vm);
			if (temp == ERROR)return ERROR;
		}
		if (do_step) press_any_key_to_continue(NULL);
		return SUCCESS;
	}
	else
	{
		do
		{
			U8_step(vm);
			if (do_echo)
			{
				temp = U8_print(vm);
				if (temp == ERROR)return ERROR;
			}
			if (do_step) press_any_key_to_continue(NULL);
		} while (TAG != HALT);
	}
	return SUCCESS;
}

state U8_WriteIO(U8VM* vm, const byte io[16], const byte if_use[16])
{
	int i;
	if (!vm || !io || !if_use)return ERROR;
	for (i = 0; i < 16; i++)
		if (if_use[i])
			vm->mem[i] = io[i];
	return SUCCESS;
}