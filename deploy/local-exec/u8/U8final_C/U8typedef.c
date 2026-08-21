#include "U8typedef.h"
int get_key_press(void) {
#ifdef _WIN32
    return _getch();
#else
    struct termios oldt, newt;
    int ch;

    tcgetattr(STDIN_FILENO, &oldt);
    newt = oldt;

    newt.c_lflag &= ~(ICANON | ECHO);
    tcsetattr(STDIN_FILENO, TCSANOW, &newt);

    ch = getchar();

    tcsetattr(STDIN_FILENO, TCSANOW, &oldt);

    return ch;
#endif
}

void press_any_key_to_continue(const char* message) {
    if (!message)
        message = "Press any key to continue...";

    puts(message);
    fflush(stdout);

    get_key_press();
    puts("");
}
