#pragma warning(disable : 4996)
#ifndef U8COMPILER_H
#define U8COMPILER_H
#include "U8typedef.h"

int com(const void* a, const void* b);
state U8_Compile(const char* code, byte res[256], size_t* res_len);

#endif
