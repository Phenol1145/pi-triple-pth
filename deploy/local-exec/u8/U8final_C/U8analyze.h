#ifndef U8ANALYZE_H
#define U8ANALYZE_H
#include "U8typedef.h"
#include "U8Set.h"
typedef struct
{
	byte mem_in_use[256];
	Set possible_value[256];
	word read_as_ins[256];
	word read_as_data[256];
	word write[256];
	byte tag;
	byte reg[7];
	Set reg_possible_value[7];
	word reg_read[7];
	word reg_write[7];
	clock t;
}U8Analyze;

#endif
