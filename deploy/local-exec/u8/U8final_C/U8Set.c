#include "U8Set.h"
byte pool1[256], pool2[256];
state set_build(Set* set, byte* data, word len)
{
	int i;
	if (!set || !data)return ERROR;
	memset(pool1, 0, sizeof(pool1));
	memset(set->data, 0, sizeof(set->data));
	for (i = 0; i < len; i++)
		pool1[data[i]] = 1;
	set->len = 0;
	for (i = 0; i < sizeof(pool1); i++)
		if (pool1[i] > 0)
			set->data[set->len++] = i;
	return SUCCESS;
}

PRIVATE state set_remove_u(Set* set, byte data)
{
	int i;
	for (i = 0; i < set->len; i++)
	{
		if (data == set->data[i])
		{
			if (i == set->len - 1)
				set->data[i] = 0;
			else
				memmove(&(set->data[i]), &(set->data[i + 1]), set->len - i - 1);
			set->len--;
			return SUCCESS;
		}
	}
	return ERROR;
}

state set_remove(Set* set, byte data)
{
	int i;
	if (!set)return ERROR;
	for (i = 0; i < set->len; i++)
	{
		if (data == set->data[i])
		{
			if (i == set->len - 1)
				set->data[i] = 0;
			else
				memmove(&(set->data[i]), &(set->data[i + 1]), set->len - i - 1);
			set->len--;
			break;
		}
	}
	return SUCCESS;
}

PRIVATE state set_append_u(Set* set, byte data)
{
	int i;
	if (set->len >= sizeof(set->data)) return ERROR;
	for (i = 0; i < set->len; i++)
		if (data == set->data[i]) return ERROR;
	set->data[set->len++] = data;
	return SUCCESS;
}

state set_append(Set* set, byte data)
{
	int i;
	if (!set || set->len >= sizeof(set->data)) return ERROR;
	for (i = 0; i < set->len; i++)
		if (data == set->data[i]) return SUCCESS;
	set->data[set->len++] = data;
	return SUCCESS;
}

void prepare(Set* a, Set* b)
{
	int i;
	memset(pool1, 0, sizeof(pool1));
	memset(pool2, 0, sizeof(pool2));
	if (a->len <= b->len)
	{
		for (i = 0; i < a->len; i++)
		{
			pool1[a->data[i]] = 1;
			pool2[b->data[i]] = 1;
		}
		for (; i < b->len; i++)
			pool2[b->data[i]] = 1;
	}
	else
	{
		for (i = 0; i < b->len; i++)
		{
			pool1[a->data[i]] = 1;
			pool2[b->data[i]] = 1;
		}
		for (; i < a->len; i++)
			pool2[a->data[i]] = 1;
	}
}

void set_intersect_u(Set* res)
{
	int i;
	memset(res->data, 0, sizeof(res->data));
	res->len = 0;
	for (i = 0; i < sizeof(pool1); i++)
		if (pool1[i] && pool2[i])
			res->data[res->len++] = i;
}

state set_intersect(Set* a, Set* b, Set* res)
{
	if (!a || !b)return ERROR;
	prepare(a, b);
	if (res)set_intersect_u(res);
	else set_intersect_u(a);
	return SUCCESS;
}

void set_union_u(Set* res)
{
	int i;
	memset(res->data, 0, sizeof(res->data));
	res->len = 0;
	for (i = 0; i < sizeof(pool1); i++)
		if (pool1[i] || pool2[i])
			res->data[res->len++] = i;
}

state set_union(Set* a, Set* b, Set* res)
{

	if (!a || !b)return ERROR;
	prepare(a, b);
	if (res)set_union_u(res);
	else set_union_u(a);
	return SUCCESS;
}

void set_differ_u(Set* res)
{
	int i;
	memset(res->data, 0, sizeof(res->data));
	res->len = 0;
	for (i = 0; i < sizeof(pool1); i++)
		if (pool1[i] && !pool2[i])
			res->data[res->len++] = i;
}

state set_differ(Set* a, Set* b, Set* res)
{
	if (!a || !b)return ERROR;
	prepare(a, b);
	if (res) set_differ_u(res);
	else set_differ_u(a);
	return SUCCESS;
}

void set_is_subset_u(Set* a, Set* b, int* res)//a<b
{
	int i;
	if (a->len > b->len)
	{
		*res = FALSE;
		return;
	}
	prepare(a, b);
	for (i = 0; i < sizeof(pool1); i++)
		if (pool1[i] && !pool2[i])
		{
			*res = FALSE;
			return;
		}
	*res = TRUE;
}

state set_is_subset(Set* a, Set* b, int* res)
{
	if (!a || !b || !res)return ERROR;
	set_is_subset_u(a, b, res);
	return SUCCESS;
}

void set_eq_u(Set* a, Set* b, int* res)
{
	int i;
	if (a->len != b->len)
	{
		*res = FALSE;
		return;
	}
	prepare(a, b);
	for (i = 0; i < sizeof(pool1); i++)
		if (pool1[i] ^ pool2[i])
		{
			*res = FALSE;
			return;
		}
	*res = TRUE;
}

state set_eq(Set* a, Set* b, int* res)
{
	if (!a || !b || !res) return ERROR;
	set_eq_u(a, b, res);
	return SUCCESS;
}

void set_is_proper_subset_u(Set* a, Set* b, int* res)
{
	int i;
	if (a->len >= b->len)
	{
		*res = FALSE;
		return;
	}
	prepare(a, b);
	for (i = 0; i < sizeof(pool1); i++)
		if (pool1[i] && !pool2[i])
		{
			*res = FALSE;
			return;
		}
	*res = TRUE;
	return;
}

state set_is_proper_subset(Set* a, Set* b, int* res)
{
	if (!a || !b || !res) return ERROR;
	set_is_proper_subset_u(a, b, res);
	return SUCCESS;
}
