#include "DragCancellation.h"
#include <signal.h>
#include <stdatomic.h>
#include <string.h>
#if ATOMIC_INT_LOCK_FREE != 2
#error "Drag cancellation requires always-lock-free atomic int on this target"
#endif
static _Atomic int requested;
static struct sigaction previous;
static int installed;
static void request_cancel(int signal_number) {
    (void)signal_number;
    atomic_store_explicit(&requested, 1, memory_order_relaxed);
}
int VunemiDragCancelInstall(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = request_cancel;
    sigemptyset(&action.sa_mask);
    atomic_store_explicit(&requested, 0, memory_order_relaxed);
    if (sigaction(SIGUSR1, &action, &previous) != 0) return -1;
    installed = 1;
    return 0;
}
int VunemiDragCancelRequested(void) { return atomic_load_explicit(&requested, memory_order_relaxed); }
void VunemiDragCancelRestore(void) { if (installed) { sigaction(SIGUSR1, &previous, 0); installed = 0; } }
