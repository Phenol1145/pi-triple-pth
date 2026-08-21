#include "U8compiler.h"
static int current_line = 1;
static const char* current_cur = NULL;
PRIVATE state parse_number(const char* s, uint* value)
{
    const char* p = s;
    uint val = 0;
    char c;
    uint d;
    if (p[0] == '0' && (p[1] == 'B' || p[1] == 'b'))
    {
        p += 2;
        while (*p)
        {
            if (*p != '0' && *p != '1') return ERROR;
            val = val * 2u + (uint)(*p - '0');
            p++;
        }
    }
    else if (p[0] == '0' && (p[1] == 'O' || p[1] == 'o'))
    {
        p += 2;
        while (*p)
        {
            if (*p < '0' || *p > '7') return ERROR;
            val = val * 8u + (uint)(*p - '0');
            p++;
        }
    }
    else if (p[0] == '0' && (p[1] == 'X' || p[1] == 'x'))
    {
        p += 2;
        while (*p)
        {
            c = *p;
            if (c >= '0' && c <= '9') d = (uint)(c - '0');
            else if (c >= 'A' && c <= 'F') d = (uint)(c - 'A' + 10);
            else if (c >= 'a' && c <= 'f') d = (uint)(c - 'a' + 10);
            else return ERROR;
            val = val * 16u + d;
            p++;
        }
    }
    else
    {
        if (*p == '\0') return 0;
        while (*p)
        {
            if (*p < '0' || *p > '9') return ERROR;
            val = val * 10u + (uint)(*p - '0');
            p++;
        }
    }

    *value = val;
    return SUCCESS;
}

PRIVATE void toktab_init(U8toktab* obj)
{
    memset(obj, 0, sizeof(*obj));
}

PRIVATE void ins_init(U8ins* ins)
{
    memset(ins, 0, sizeof(*ins));
}

char* strtok_r(char* str, const char* delim, char** saveptr)
{
    char* token;
    if (!saveptr) return NULL;

    if (str) *saveptr = str;
    else if (!(*saveptr)) return NULL;

    if (**saveptr == '\0') return NULL;

    *saveptr += strspn(*saveptr, delim);

    if (**saveptr == '\0') return NULL;

    token = *saveptr;

    *saveptr = strpbrk(token, delim);
    if (*saveptr)
    {
        **saveptr = '\0';
        (*saveptr)++;
    }
    else *saveptr = token + strlen(token);

    return token;
}

PRIVATE void asm_preparse(char* code, char* pure_code)
{
    char* sp1 = NULL;
    char* line_cut = strtok_r(code, "\n\r", &sp1), * comment;
    uint line = 0;
    char buffer[8];
    int flag = FALSE;
    while (line_cut)
    {
        line++;
        if (line_cut[0] == ' ' || line_cut[0] == '\t')
        {
            flag = TRUE;
            line_cut = strtok_r(NULL, "\n\r", &sp1);
            continue;
        }
        comment = strchr(line_cut, ';');
        if (comment)*comment = '\0';
        if (line_cut[0] == '\0')
        {
            flag = TRUE;
            line_cut = strtok_r(NULL, "\n\r", &sp1);
            continue;
        }
        if (flag)
        {
            sprintf(buffer, "@%u\n", line);
            pure_code = strcat(pure_code, buffer);
            flag = FALSE;
        }
        pure_code = strcat(pure_code, line_cut);
        pure_code = strcat(pure_code, "\n");
        line_cut = strtok_r(NULL, "\n\r", &sp1);
    }
}

PRIVATE state asm_tokenizer(char* pure_code, U8toktab* obj)
{
    char* sp1 = NULL, * sp2 = NULL;
    char* line_cut = strtok_r(pure_code, "\n", &sp1), * token_cut;
    uint line = 0;
    while (line_cut)
    {
        if (line_cut[0] == '@')
        {
            sscanf(line_cut, "@%u", &line);
            line--;
            line_cut = strtok_r(NULL, "\n", &sp1);
            continue;
        }
        line++;
        token_cut = strtok_r(line_cut, " \t", &sp2);
        if (token_cut)
        {
            if (obj->line_count >= 236)
            {
                toktab_init(obj);
                return ERROR;
            }
            strncpy(obj->token[obj->line_count][0], token_cut, TOKEN_LEN-1);
            token_cut = strtok_r(NULL, " \t", &sp2);
            if (token_cut)
            {
                strncpy(obj->token[obj->line_count][1], token_cut, TOKEN_LEN-1);
                token_cut = strtok_r(NULL, " \t", &sp2);
                if (token_cut)
                {
                    strncpy(obj->token[obj->line_count][2], token_cut, TOKEN_LEN-1);
                    token_cut = strtok_r(NULL, " \t", &sp2);
                    if (token_cut)
                        obj->error[obj->line_count] = TRUE;
                    obj->line[obj->line_count++] = (word)line;
                    line_cut = strtok_r(NULL, "\n", &sp1);
                    continue;
                }
                else
                {
                    obj->line[obj->line_count++] = (word)line;
                    line_cut = strtok_r(NULL, "\n", &sp1);
                    continue;
                }
            }
            else
            {
                obj->line[obj->line_count++] = (word)line;
                line_cut = strtok_r(NULL, "\n", &sp1);
                continue;
            }
        }
    }
    return SUCCESS;
}

PRIVATE state reg_encode(const char r[TOKEN_LEN],byte* res)
{
    if (!strcmp(r, "%A"))
    {
        *res = REG_A;
        return SUCCESS;
    }
    else if (!strcmp(r, "%B"))
    {
        *res = REG_B;
        return SUCCESS;
    }
    else if (!strcmp(r, "%X"))
    {
        *res = REG_X;
        return SUCCESS;
    }
    else if (!strcmp(r, "%Y"))
    {
        *res = REG_Y;
        return SUCCESS;
    }
    else return ERROR;
}

PRIVATE state mov_encode(const char r1[TOKEN_LEN], const char r2[TOKEN_LEN], byte* res)
{
    byte temp = (byte)(MOV << 4u);
    byte r1b, r2b;
    state s = reg_encode(r1, &r1b);
    if (s == ERROR)return ERROR;
    s = reg_encode(r2, &r2b);
    if (s == ERROR)return ERROR;
    temp += (byte)(r1b << 2u) + r2b;
    *res = temp;
    return SUCCESS;
}

PRIVATE state ldm_encode(const char r[TOKEN_LEN], byte* res)
{
    byte temp = (byte)(LDM << 4u);
    byte rb;
    state s = reg_encode(r, &rb);
    if (s == ERROR)return ERROR;
    temp += rb;
    *res = temp;
    return SUCCESS;
}

PRIVATE state svm_encode(const char r[TOKEN_LEN], byte* res)
{
    byte temp = (byte)(SVM << 4u);
    byte rb;
    state s = reg_encode(r, &rb);
    if (s == ERROR)return ERROR;
    temp += rb;
    *res = temp;
    return SUCCESS;
}

PRIVATE state lah_encode(const char imm[TOKEN_LEN], byte* res)
{
    byte temp = (byte)(LAH << 4u);
    uint ub;
    state s = parse_number(imm, &ub);
    if (s == ERROR || ub > 15u)return ERROR;
    temp += ub;
    *res = temp;
    return SUCCESS;
}

PRIVATE state lal_encode(const char imm[TOKEN_LEN], byte* res)
{
    byte temp = (byte)(LAL << 4u);
    uint ub;
    state s = parse_number(imm, &ub);
    if (s == ERROR || ub > 15u)return ERROR;
    temp += ub;
    *res = temp;
    return SUCCESS;
}

PRIVATE state lxh_encode(const char imm[TOKEN_LEN], byte* res)
{
    byte temp = (byte)(LXH << 4u);
    uint ub;
    state s = parse_number(imm, &ub);
    if (s == ERROR || ub > 15u)return ERROR;
    temp += ub;
    *res = temp;
    return SUCCESS;
}

PRIVATE state lxl_encode(const char imm[TOKEN_LEN], byte* res)
{
    byte temp = (byte)(LXL << 4u);
    uint ub;
    state s = parse_number(imm, &ub);
    if (s == ERROR || ub > 15u)return ERROR;
    temp += ub;
    *res = temp;
    return SUCCESS;
}

PRIVATE state jmp_encode(byte op, byte* res)
{
    byte temp = (byte)(JMP << 4u);
    temp += op;
    *res = temp;
    return SUCCESS;
}

PRIVATE state alu_encode(byte op, byte* res)
{
    byte temp = (byte)(ALU << 4u);
    temp += op;
    *res = temp;
    return SUCCESS;
}

PRIVATE state push_encode(const char r[TOKEN_LEN], byte* res)
{
    byte temp = (byte)(PUSH << 4u);
    byte rb;
    state s = reg_encode(r, &rb);
    if (s == ERROR)return ERROR;
    temp += rb;
    *res = temp;
    return SUCCESS;
}

PRIVATE state pop_encode(const char r[TOKEN_LEN], byte* res)
{
    byte temp = (byte)(POP << 4u);
    byte rb;
    state s = reg_encode(r, &rb);
    if (s == ERROR)return ERROR;
    temp += rb;
    *res = temp;
    return SUCCESS;
}

PRIVATE state call_encode(byte* res)
{
    byte temp = (byte)(CALL << 4u);
    *res = temp;
    return SUCCESS;
}

PRIVATE state ret_encode(byte* res)
{
    byte temp = (byte)(RET << 4u);
    *res = temp;
    return SUCCESS;
}

PRIVATE state qop_encode(byte ins, byte op, const char r[TOKEN_LEN], byte* res)
{
    byte temp = (byte)(ins << 4u);
    byte rb;
    state s = reg_encode(r, &rb);
    if (s == ERROR)return ERROR;
    temp += (byte)(op << 2u) + rb;
    *res = temp;
    return SUCCESS;
}

PRIVATE state hlt_encode(byte* res)
{
    byte temp = (byte)(HLT << 4u);
    *res = temp;
    return SUCCESS;
}

PRIVATE state dat_encode(const char n[TOKEN_LEN], byte* res)
{
    uint ub;
    state s = parse_number(n, &ub);
    if (s == ERROR || ub > 255u)return ERROR;
    *res = (byte)ub;
    return SUCCESS;
}

PRIVATE state db_encode(const char imm[TOKEN_LEN], byte* res)
{
    uint ub;
    state s = parse_number(imm, &ub);
    if (s == ERROR || ub > 255u)return ERROR;
    *res = (byte)ub;
    return SUCCESS;
}

PRIVATE state dw_encode(const char imm[TOKEN_LEN], word* res)
{
    uint ub;
    state s = parse_number(imm, &ub);
    if (s == ERROR || ub > 65535u)return ERROR;
    *res = (word)ub;
    return SUCCESS;
}

PRIVATE state dd_encode(const char imm[TOKEN_LEN], uint* res)
{
    uint ub;
    state s = parse_number(imm, &ub);
    if (s == ERROR)return ERROR;
    *res = ub;
    return SUCCESS;
}

PRIVATE void asm_compile(U8toktab* obj, U8ins* ins,int check)
{
    int i;
    state s;
    dword temp;
    if (check)
    {
        for (i = 0; i < obj->line_count; i++)
        {
            if (obj->error[i])
            {
                ins->error_line[ins->error_count++] = obj->line[i];
                continue;
            }
            if (!strcmp(obj->token[i][0], "MOV"))       s = mov_encode(obj->token[i][1], obj->token[i][2], &temp.b);
            else if (!strcmp(obj->token[i][0], "LDM"))  s = ldm_encode(obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "SVM"))  s = svm_encode(obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "LAH"))  s = lah_encode(obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "LAL"))  s = lal_encode(obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "LXH"))  s = lxh_encode(obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "LXL"))  s = lxl_encode(obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "PUSH")) s = push_encode(obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "POP"))  s = pop_encode(obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "CALL")) s = call_encode(&temp.b);
            else if (!strcmp(obj->token[i][0], "RET"))  s = ret_encode(&temp.b);
            else if (!strcmp(obj->token[i][0], "HLT"))  s = hlt_encode(&temp.b);
            else if (!strcmp(obj->token[i][0], "GOTO")) s = jmp_encode(GOTO, &temp.b);
            else if (!strcmp(obj->token[i][0], "Z"))    s = jmp_encode(Z, &temp.b);
            else if (!strcmp(obj->token[i][0], "NZ"))   s = jmp_encode(NZ, &temp.b);
            else if (!strcmp(obj->token[i][0], "C"))    s = jmp_encode(C, &temp.b);
            else if (!strcmp(obj->token[i][0], "NC"))   s = jmp_encode(NC, &temp.b);
            else if (!strcmp(obj->token[i][0], "P"))    s = jmp_encode(P, &temp.b);
            else if (!strcmp(obj->token[i][0], "NP"))   s = jmp_encode(NP, &temp.b);
            else if (!strcmp(obj->token[i][0], "T"))    s = jmp_encode(T, &temp.b);
            else if (!strcmp(obj->token[i][0], "NT"))   s = jmp_encode(NT, &temp.b);
            else if (!strcmp(obj->token[i][0], "E"))    s = jmp_encode(E, &temp.b);
            else if (!strcmp(obj->token[i][0], "NE"))   s = jmp_encode(NE, &temp.b);
            else if (!strcmp(obj->token[i][0], "GT"))   s = jmp_encode(GT, &temp.b);
            else if (!strcmp(obj->token[i][0], "LT"))   s = jmp_encode(LT, &temp.b);
            else if (!strcmp(obj->token[i][0], "NOP"))  s = jmp_encode(NOP, &temp.b);
            else if (!strcmp(obj->token[i][0], "OR"))   s = alu_encode(OR, &temp.b);
            else if (!strcmp(obj->token[i][0], "AND"))  s = alu_encode(AND, &temp.b);
            else if (!strcmp(obj->token[i][0], "INH"))  s = alu_encode(INH, &temp.b);
            else if (!strcmp(obj->token[i][0], "IMP"))  s = alu_encode(IMP, &temp.b);
            else if (!strcmp(obj->token[i][0], "XOR"))  s = alu_encode(XOR, &temp.b);
            else if (!strcmp(obj->token[i][0], "NOR"))  s = alu_encode(NOR, &temp.b);
            else if (!strcmp(obj->token[i][0], "XNOR")) s = alu_encode(XNOR, &temp.b);
            else if (!strcmp(obj->token[i][0], "NAND")) s = alu_encode(NAND, &temp.b);
            else if (!strcmp(obj->token[i][0], "LSH"))  s = alu_encode(LSH, &temp.b);
            else if (!strcmp(obj->token[i][0], "RSH"))  s = alu_encode(RSH, &temp.b);
            else if (!strcmp(obj->token[i][0], "RLS"))  s = alu_encode(RLS, &temp.b);
            else if (!strcmp(obj->token[i][0], "RRS"))  s = alu_encode(RRS, &temp.b);
            else if (!strcmp(obj->token[i][0], "ADD"))  s = alu_encode(ADD, &temp.b);
            else if (!strcmp(obj->token[i][0], "SUB"))  s = alu_encode(SUB, &temp.b);
            else if (!strcmp(obj->token[i][0], "MUL"))  s = alu_encode(MUL, &temp.b);
            else if (!strcmp(obj->token[i][0], "DIV"))  s = alu_encode(DIV, &temp.b);
            else if (!strcmp(obj->token[i][0], "INC"))  s = qop_encode(QOP1, INC, obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "DEC"))  s = qop_encode(QOP1, DEC, obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "NOT"))  s = qop_encode(QOP1, NOT, obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "ZERO")) s = qop_encode(QOP1, ZERO, obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "REV"))  s = qop_encode(QOP2, REV, obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "PC"))   s = qop_encode(QOP2, POPCNT, obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "CLZ"))  s = qop_encode(QOP2, CLZ, obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "CTZ"))  s = qop_encode(QOP2, CTZ, obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "DAT"))  s = dat_encode(obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "DB"))   s = db_encode(obj->token[i][1], &temp.b);
            else if (!strcmp(obj->token[i][0], "DW"))   s = dw_encode(obj->token[i][1], &temp.w);
            else if (!strcmp(obj->token[i][0], "DD"))   s = dd_encode(obj->token[i][1], &temp.d);
            else s = ERROR;
            if (s == ERROR)ins->error_line[ins->error_count++] = obj->line[i];
        }
    }
    else
    {
        for (i = 0; i < obj->line_count; i++)
        {
            if (!strcmp(obj->token[i][0], "MOV"))
            {
                s = mov_encode(obj->token[i][1], obj->token[i][2], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "LDM"))
            {
                s = ldm_encode(obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "SVM"))
            {
                s = svm_encode(obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "LAH"))
            {
                s = lah_encode(obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "LAL"))
            {
                s = lal_encode(obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "LXH"))
            {
                s = lxh_encode(obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "LXL"))
            {
                s = lxl_encode(obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "PUSH"))
            {
                s = push_encode(obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "POP"))
            {
                s = pop_encode(obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "CALL"))
            {
                s = call_encode(&temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "RET"))
            {
                s = ret_encode(&temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "HLT"))
            {
                s = hlt_encode(&temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "GOTO"))
            {
                s = jmp_encode(GOTO, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "Z"))
            {
                s = jmp_encode(Z, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "NZ"))
            {
                s = jmp_encode(NZ, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "C"))
            {
                s = jmp_encode(C, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "NC"))
            {
                s = jmp_encode(NC, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "P"))
            {
                s = jmp_encode(P, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "NP"))
            {
                s = jmp_encode(NP, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "T"))
            {
                s = jmp_encode(T, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "NT"))
            {
                s = jmp_encode(NT, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "E"))
            {
                s = jmp_encode(E, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "NE"))
            {
                s = jmp_encode(NE, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "GT"))
            {
                s = jmp_encode(GT, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "LT"))
            {
                s = jmp_encode(LT, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "NOP"))
            {
                s = jmp_encode(NOP, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "OR"))
            {
                s = alu_encode(OR, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "AND"))
            {
                s = alu_encode(AND, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "INH"))
            {
                s = alu_encode(INH, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "IMP"))
            {
                s = alu_encode(IMP, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "XOR"))
            {
                s = alu_encode(XOR, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "NOR"))
            {
                s = alu_encode(NOR, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "XNOR"))
            {
                s = alu_encode(XNOR, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "NAND"))
            {
                s = alu_encode(NAND, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "LSH"))
            {
                s = alu_encode(LSH, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "RSH"))
            {
                s = alu_encode(RSH, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "RLS"))
            {
                s = alu_encode(RLS, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "RRS"))
            {
                s = alu_encode(RRS, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "ADD"))
            {
                s = alu_encode(ADD, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "SUB"))
            {
                s = alu_encode(SUB, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "MUL"))
            {
                s = alu_encode(MUL, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "DIV"))
            {
                s = alu_encode(DIV, &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "INC"))
            {
                s = qop_encode(QOP1, INC, obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "DEC"))
            {
                s = qop_encode(QOP1, DEC, obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "NOT"))
            {
                s = qop_encode(QOP1, NOT, obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "ZERO"))
            {
                s = qop_encode(QOP1, ZERO, obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "REV"))
            {
                s = qop_encode(QOP2, REV, obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "PC"))
            {
                s = qop_encode(QOP2, POPCNT, obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "CLZ"))
            {
                s = qop_encode(QOP2, CLZ, obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "CTZ"))
            {
                s = qop_encode(QOP2, CTZ, obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                ins->ins[ins->ins_count++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "DAT"))
            {
                s = dat_encode(obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                temp.w = temp.b;
                if (temp.w + ins->data_len > 236u)goto ERROR_DEAL_MEMORY;
                ins->data_len += temp.b;
            }
            else if (!strcmp(obj->token[i][0], "DB"))
            {
                s = db_encode(obj->token[i][1], &temp.b);
                if (s == ERROR)goto ERROR_DEAL;
                if (ins->data_len > 235u)goto ERROR_DEAL_MEMORY;
                ins->data[ins->data_len++] = temp.b;
            }
            else if (!strcmp(obj->token[i][0], "DW"))
            {
                s = dw_encode(obj->token[i][1], &temp.w);
                if (s == ERROR)goto ERROR_DEAL;
                if (ins->data_len > 234u)goto ERROR_DEAL_MEMORY;
                ins->data[ins->data_len++] = temp.w & 0xFF;
                ins->data[ins->data_len++] = (byte)((temp.w >> 8u) & 0xFF);
            }
            else if (!strcmp(obj->token[i][0], "DD"))
            {
                s = dd_encode(obj->token[i][1], &temp.d);
                if (s == ERROR)goto ERROR_DEAL;
                if (ins->data_len > 234u)goto ERROR_DEAL_MEMORY;
                ins->data[ins->data_len++] = temp.d & 0xFF;
                ins->data[ins->data_len++] = (byte)((temp.d >> 8u) & 0xFF);
                ins->data[ins->data_len++] = (byte)((temp.d >> 16u) & 0xFF);
                ins->data[ins->data_len++] = (byte)((temp.d >> 24u) & 0xFF);
            }
            else goto ERROR_DEAL;
        }
    }
    return;
ERROR_DEAL:
    ins_init(ins);
    asm_compile(obj, ins, TRUE);
    return;
ERROR_DEAL_MEMORY:
    ins_init(ins);
    ins->error_line[ins->error_count++] = obj->line[i];
    asm_compile(obj, ins, TRUE);
}

PRIVATE char* get_line_start(const char* s, int n)
{
    if (s)
    {
        current_line = 1;
        current_cur = s;
    }
    if (n < 1) return NULL;
    if (current_line > n)current_line = 1;
    while (current_line < n && *current_cur != '\0')
    {
        if (*current_cur == '\n')
        {
            current_line++;
            current_cur++;
        }
        else if (*current_cur == '\r')
        {
            current_line++;
            current_cur++;
            if (*current_cur == '\n')current_cur++;
        }
        else current_cur++;
    }
    if (current_line == n) return (char*)current_cur;
    return NULL;
}

int com(const void* a, const void* b)
{
    return (*(word*)a) > (*(word*)b) ? 1 : -1;
}

PRIVATE state asm_ErrorReport(const char* code, U8ins* ins)
{
    int i;
    char* code_line;
    if (ins->error_count == 0) return SUCCESS;
    qsort(ins->error_line, ins->error_count, sizeof(word), com);
    puts("Error line(s):");
    code_line = get_line_start(code, ins->error_line[0]);
    if (!code_line)return ERROR;
    printf("Line %u: ", ins->error_line[0]);
    while (*code_line != '\r' && *code_line != '\n' && *code_line != '\0')
    {
        putchar(*code_line);
        code_line++;
    }
    puts("");
    for (i = 1; i < ins->error_count; i++)
    {
        code_line = get_line_start(NULL, ins->error_line[i]);
        if (!code_line)return ERROR;
        printf("Line %u: ", ins->error_line[i]);
        while (*code_line != '\r' && *code_line != '\n' && *code_line != '\0')
        {
            putchar(*code_line);
            code_line++;
        }
        puts("");
    }
    return SUCCESS;
}

PRIVATE void asm_combiner(U8ins* ins, byte* res)
{
    int i;
    for (i = 0; i < ins->ins_count; i++) *(res++) = ins->ins[i];
    for (i = 0; i < ins->data_len; i++)*(res++) = ins->data[i];
}

state U8_Compile(const char* code,byte res[256],size_t* res_len)
{
    U8toktab* toktab = (U8toktab*)malloc(sizeof(U8toktab));
    U8ins* ins = (U8ins*)malloc(sizeof(U8ins));
    char* code_copy, * pure_code;
    size_t len;
    state s;
    int i;
    if (!code || !res || !res_len)
    {
        free(toktab);
        free(ins);
        return ERROR;
    }
    len = strlen(code) + 1;
    code_copy = (char*)malloc(len);
    pure_code = (char*)malloc(len + 1536ull);
    if (!toktab || !ins || !code_copy || !pure_code)
    {
        free(toktab);
        free(ins);
        free(code_copy);
        free(pure_code);
        return ERROR;
    }
    strcpy(code_copy, code);
    memset(pure_code, 0, len + 1536ull);
    asm_preparse(code_copy, pure_code);
    toktab_init(toktab);
    s = asm_tokenizer(pure_code, toktab);
    if (s == ERROR)
    {
        free(toktab);
        free(ins);
        free(code_copy);
        free(pure_code);
        return ERROR;
    }
    ins_init(ins);
    for (i = 0; i < toktab->line_count; i++)
    {
        if (toktab->error[i])
        {
            asm_compile(toktab, ins, TRUE);
            asm_ErrorReport(code, ins);
            free(toktab);
            free(ins);
            free(code_copy);
            free(pure_code);
            return SUCCESS;
        }
    }
    asm_compile(toktab, ins, FALSE);
    if (ins->error_count != 0)
    {
        asm_ErrorReport(code, ins);
        *res_len = 0;
        free(toktab);
        free(ins);
        free(code_copy);
        free(pure_code);
        return SUCCESS;
    }
    memset(res, 0, 256);
    asm_combiner(ins, res);
    *res_len = ins->data_len + ins->ins_count;
    free(toktab);
    free(ins);
    free(code_copy);
    free(pure_code);
    return SUCCESS;
}
