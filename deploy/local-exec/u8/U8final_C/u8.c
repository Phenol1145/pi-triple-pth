#pragma warning(disable : 4996)

#include "U8VM.h"
#include "U8compiler.h"
#define U8_VERSION "0.0.2"
#define NONE	0
#define HELP	1
#define VERSION	2
#define COMPILE	3
#define RUN		4
#define DEBUG	5
#define ANALYZE	6
#define UNKNOWN	7

const static byte u8_head[] = { 'u','8','u','8' };
const static byte True_Arr[16] = {
1,1,1,1,
1,1,1,1,
1,1,1,1,
1,1,1,1 };

PRIVATE void help(int cmd)
{
	switch (cmd)
	{
	case NONE:
		puts("\
u8 [-v | --version] [-h | --help] <command> [<args>]\n\
Commands:\n\
help    [<command>]         | show the help text\n\
version                     | show the version of U8\n\
compile <source> [<output>] | compile the code\n\
run     <programme>         | run the programme\n\
debug   <programme>         | debug a programme\n\
analyze <code>              | do static analyze of code");
		break;
	case HELP:
		puts("\
help    [<command>]         | show the help text\n\
It will show the usage text and command list if <command> is not provided.\n\
It will show details of a command if <command> is provided.");
		break;
	case VERSION:
		puts("\
version                     | show the version of U8\n\
It will show the version of U8 like this:\n\
U8 version:0.0.1");
		break;
	case COMPILE:
		puts("\
compile <source> [<output>] | compile the code\n\
<source> means the path of the source code and <output> means that of the result.\n\
The result will be put in the same directory of <source> if <output> is not provided.\n\
The suggested file extension:\n\
<source> | .u8asm\n\
<output> | .u8programme");
		break;
	case RUN:
		puts("\
run     <programme>         | run the programme\n\
<programme> means the path of the programme.\n\
The suggested file extension: .u8programme");
		break;
	case DEBUG:
		puts("\
debug   <programme>         | debug a programme\n\
");
		break;
	case ANALYZE:
		puts("\
analyze <code>              | do static analyze of code");
		break;
	case UNKNOWN:
	default:
		puts("Unknown command!");
		break;
	}
}

PRIVATE void version(void)
{
	printf("U8 version:%s\n", U8_VERSION);
}

PRIVATE void too_many(void)
{
	puts("Too many arguments!");
}

PRIVATE void too_few(void)
{
	puts("Too few arguments!");
}

PRIVATE char* read_file_to_memory(const char* filename, size_t* file_size)
{
	FILE* file = fopen(filename, "rb");
	char* buffer;
	size_t bytes_read;
	long temp;
	if (!file) return NULL;
	if (fseek(file, 0, SEEK_END) != 0)
	{
		fclose(file);
		return NULL;
	}
	temp = ftell(file);
	if (temp < 0)
	{
		fclose(file);
		return NULL;
	}
	*file_size = (size_t)temp;
	rewind(file);
	buffer = (char*)malloc(*file_size + 1);
	if (!buffer)
	{
		fclose(file);
		return NULL;
	}
	bytes_read = fread(buffer, 1, *file_size, file);
	if (bytes_read != *file_size)
	{
		free(buffer);
		fclose(file);
		return NULL;
	}

	buffer[*file_size] = '\0';
	fclose(file);

	return buffer;
}

PRIVATE void change_extension(char* path)
{
	int len = strlen(path);
	int i;
	int last_dot = -1;
	int last_slash = -1;

	for (i = len - 1; i >= 0; i--)
	{
		if (path[i] == '.' && last_dot == -1)
			last_dot = i;
		if (path[i] == '/' || path[i] == '\\')
		{
			last_slash = i;
			break;
		}
	}

	if (last_dot == -1 || (last_slash != -1 && last_dot < last_slash))
		goto CHANGE_EXTENSION;
	if (last_slash + 1 == last_dot)
		goto CHANGE_EXTENSION;
	path[last_dot] = '\0';
CHANGE_EXTENSION:
	strcat(path, ".u8programme");
}

PRIVATE void compiler(const char* input_path, const char* output_path)
{
	size_t file_size;
	byte result[256];
	size_t len;
	state s;
	FILE* fp;
	char* code = read_file_to_memory(input_path, &file_size);
	char* output;
	if (!code)
	{
		puts("Cannot open source file!");
		return;
	}
	s = U8_Compile(code, result, &len);
	if (s == ERROR)
	{
		puts("Compile error!");
		free(code);
		return;
	}
	if (len == 0)
	{
		puts("Fail to generate code.");
		free(code);
		return;
	}
	if (output_path) output = output_path;
	else
	{
		output = (char*)malloc(strlen(input_path) + 256);
		if (!output)
		{
			puts("Lack of memory!");
			free(code);
			return;
		}
		strcpy(output, input_path);
		change_extension(output);
	}
	fp = fopen(output, "wb");
	if (!fp)
	{
		puts("Fail to create the binary file!");
		free(code);
		return;
	}
	fwrite(u8_head, sizeof(char), sizeof(u8_head) / sizeof(char), fp);
	fwrite(result, sizeof(byte), len, fp);
	fclose(fp);
	free(code);
	puts("Compile successfully.");
}

PRIVATE byte get_input(const char* prompt,byte default_value)
{
	char buffer[256];
	char* endptr;
	long result;

	while (TRUE)
	{
		if (prompt)
		{
			printf("%s", prompt);
			fflush(stdout);
		}
		if (!fgets(buffer, sizeof(buffer), stdin)) return default_value;
		buffer[strcspn(buffer, "\n")] = '\0';
		if (buffer[0] == '\0') return default_value;
		errno = 0;
		result = strtol(buffer, &endptr, 0);
		while (isspace((unsigned char)*endptr)) endptr++;
		if (errno == ERANGE || endptr == buffer || *endptr != '\0')
		{
			puts("Invalid input!");
			continue;
		}
		if (result < 0 || result>255)
		{
			puts("Out of range!");
			continue;
		}
		return (byte)result;
	}
}
PRIVATE int parse_byte_arg(const char* text, byte* out)
{
	char* endptr;
	long result;
	if (!text || !*text) return 0;
	errno = 0;
	result = strtol(text, &endptr, 0);
	while (isspace((unsigned char)*endptr)) endptr++;
	if (errno == ERANGE || endptr == text || *endptr != '\0') return 0;
	if (result < 0 || result > 255) return 0;
	*out = (byte)result;
	return 1;
}

/* batch 模式（u8 run <programme> [--reg K=V ...] [--io N=V ...]）：
   提供任一 --reg/--io 即不再交互；未显式给定的寄存器/I/O 用交互模式的默认值。 */
PRIVATE void executer(const char* path, const byte* reg_init, const byte* io_init, int batch)
{
	size_t len;
	byte* file = (byte*)read_file_to_memory(path, &len);
	byte* code;
	byte reg[7];
	byte io[16];
	static const byte reg_defaults[7] = { 0, 0, 0, 0, 0x10, 0xff, 0 };
	static const char* const reg_prompts[7] = { "A:", "B:", "X:", "Y:", "PC:", "SP:", "CCR:" };
	static const char* const io_prompts[16] = {
		"I/O.0:", "I/O.1:", "I/O.2:", "I/O.3:",
		"I/O.4:", "I/O.5:", "I/O.6:", "I/O.7:",
		"I/O.8:", "I/O.9:", "I/O.a:", "I/O.b:",
		"I/O.c:", "I/O.d:", "I/O.e:", "I/O.f:"
	};
	U8VM vm;
	state s;
	int k;
	if (!file)
	{
		puts("Cannot open programme file!");
		return;
	}
	if (file[0] != u8_head[0] ||
		file[1] != u8_head[1] ||
		file[2] != u8_head[2] ||
		file[3] != u8_head[3])
	{
		puts("This file is not U8 programme file!");
		free(file);
		return;
	}
	code = file + 4;
	for (k = 0; k < 7; k += 1)
	{
		reg[k] = batch ? reg_init[k] : get_input(reg_prompts[k], reg_defaults[k]);
	}
	s = U8_Initialize(&vm, reg);
	if (s == ERROR)
	{
		puts("Error occurred when creating U8 VM!");
		free(file);
		return;
	}
	for (k = 0; k < 16; k += 1)
	{
		io[k] = batch ? io_init[k] : get_input(io_prompts[k], 0);
	}
	s = U8_WriteIO(&vm, io, True_Arr);
	if (s == ERROR)
	{
		puts("Error occurred when writing I/O port!");
		free(file);
		return;
	}
	s = U8_LoadProgramme(&vm, code, len);
	if (s == ERROR)
	{
		puts("Error occurred when loading code!");
		free(file);
		return;
	}
	s = U8_Run(&vm, DEFAULT);
	if (s == ERROR)
		puts("Error occurred when running the machine!");
	free(file);
}

int main(int argc, char* argv[])
{
	int i;
	for (i = 1; i < argc; i++)
	{
		if
			(
				!strcmp(argv[i], "-h")		||
				!strcmp(argv[i],"-H")		||
				!strcmp(argv[i], "-help")	||
				!strcmp(argv[i], "--help")
			)
		{
			help(NONE);
			continue;
		}
		else if
			(
				!strcmp(argv[i], "-v")			||
				!strcmp(argv[i], "-V")			||
				!strcmp(argv[i], "-version")	||
				!strcmp(argv[i], "--version")
			)
		{
			version();
			continue;
		}
		else if(!strcmp(argv[i], "compile"))
		{
			if (i == argc - 3) compiler(argv[i + 1], argv[i + 2]);
			else if (i == argc - 2) compiler(argv[i + 1], NULL);
			else if (i == argc - 1) too_few();
			else too_many();
			break;
		}
		else if (!strcmp(argv[i], "run"))
		{
			if (i == argc - 1) too_few();
			else if (i == argc - 2) executer(argv[i + 1], NULL, NULL, 0);
			else
			{
				const char* path = argv[i + 1];
				byte reg_init[7] = { 0, 0, 0, 0, 0x10, 0xff, 0 };
				byte io_init[16] = { 0 };
				int batch = 0;
				int j = i + 2;
				while (j < argc)
				{
					if (!strcmp(argv[j], "--reg"))
					{
						const char* tok;
						const char* sep;
						const char* val;
						int idx = -1;
						if (j + 1 >= argc) { too_few(); break; }
						tok = argv[++j];
						sep = strchr(tok, '=');
						if (!sep) sep = strchr(tok, ':');
						if (!sep || sep == tok) { puts("Invalid --reg value (expect A=0 / PC:16)."); break; }
						val = sep + 1;
						if (sep - tok == 1 && (toupper((unsigned char)tok[0]) == 'A')) idx = 0;
						else if (sep - tok == 1 && (toupper((unsigned char)tok[0]) == 'B')) idx = 1;
						else if (sep - tok == 1 && (toupper((unsigned char)tok[0]) == 'X')) idx = 2;
						else if (sep - tok == 1 && (toupper((unsigned char)tok[0]) == 'Y')) idx = 3;
						else if (sep - tok == 2 && toupper((unsigned char)tok[0]) == 'P' && toupper((unsigned char)tok[1]) == 'C') idx = 4;
						else if (sep - tok == 2 && toupper((unsigned char)tok[0]) == 'S' && toupper((unsigned char)tok[1]) == 'P') idx = 5;
						else if (sep - tok == 3 && toupper((unsigned char)tok[0]) == 'C' && toupper((unsigned char)tok[1]) == 'C' && toupper((unsigned char)tok[2]) == 'R') idx = 6;
						if (idx < 0 || !parse_byte_arg(val, &reg_init[idx])) { puts("Invalid --reg value."); break; }
						batch = 1;
					}
					else if (!strcmp(argv[j], "--io"))
					{
						const char* tok;
						const char* sep;
						char* endptr;
						long port;
						if (j + 1 >= argc) { too_few(); break; }
						tok = argv[++j];
						sep = strchr(tok, '=');
						if (!sep) sep = strchr(tok, ':');
						if (!sep || sep == tok) { puts("Invalid --io value (expect 0=1 / a:2)."); break; }
						errno = 0;
						port = strtol(tok, &endptr, 0);
						if (errno != 0 || endptr != sep || port < 0 || port > 15 ||
							!parse_byte_arg(sep + 1, &io_init[port])) { puts("Invalid --io value."); break; }
						batch = 1;
					}
					else { too_many(); break; }
					j += 1;
				}
				executer(path, reg_init, io_init, batch);
			}
			break;
		}
		else if (!strcmp(argv[i], "debug"))
		{
			break;
		}
		else if (!strcmp(argv[i], "analyze"))
		{
			break;
		}
		else if (!strcmp(argv[i], "help"))
		{
			if (i == argc - 2)
			{
				if (!strcmp(argv[i + 1], "compile")) help(COMPILE);
				else if (!strcmp(argv[i + 1], "run")) help(RUN);
				else if (!strcmp(argv[i + 1], "debug")) help(DEBUG);
				else if (!strcmp(argv[i + 1], "analyze")) help(ANALYZE);
				else if (!strcmp(argv[i + 1], "version")) help(VERSION);
				else if (!strcmp(argv[i + 1], "help")) help(HELP);
				else help(UNKNOWN);
			}
			else if (i == argc - 1)help(NONE);
			else too_many();
			break;
		}
		else if (!strcmp(argv[i], "version"))
		{
			if (i == argc - 1) version();
			else too_many();
			break;
		}
		else
		{
			help(UNKNOWN);
			break;
		}
	}
	return 0;
}