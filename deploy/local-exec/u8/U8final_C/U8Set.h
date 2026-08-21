#ifndef U8SET_H
#define U8SET_H
#include "U8typedef.h"
typedef struct
{
	byte data[256];
	word len;
}Set;
state set_build(Set* set, byte* data, word len);
state set_remove(Set* set, byte data);
state set_append(Set* set, byte data);
void prepare(Set* a, Set* b);
void set_intersect_u(Set* res);
state set_intersect(Set* a, Set* b, Set* res);
void set_union_u(Set* res);
state set_union(Set* a, Set* b, Set* res);
void set_differ_u(Set* res);
state set_differ(Set* a, Set* b, Set* res);
void set_is_subset_u(Set* a, Set* b, int* res);
state set_is_subset(Set* a, Set* b, int* res);
void set_eq_u(Set* a, Set* b, int* res);
state set_eq(Set* a, Set* b, int* res);
void set_is_proper_subset_u(Set* a, Set* b, int* res);
state set_is_proper_subset(Set* a, Set* b, int* res);
#endif