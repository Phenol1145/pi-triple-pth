#pragma warning(disable : 4996)
#ifndef U8VM_H
#define U8VM_H
#include "U8typedef.h"
state U8_Initialize(U8VM* vm, byte reg[7]);
state U8_LoadProgramme(U8VM* vm, byte* prog, rsize_t psz);
state U8_Step(U8VM* vm);
state U8_Print(U8VM* vm, const char* format);
state U8_Run(U8VM* vm, mode m);
state U8_WriteIO(U8VM* vm, const byte io[16], const byte if_use[16]);
#endif
