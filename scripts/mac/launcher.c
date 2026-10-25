// shapes.inc Bridge app launcher (the bundle's main executable).
//
// Finder, Spotlight and launchd all start this tiny signed program. It runs the
// bundled Node runtime with the bridge CLI: with no arguments (a double-click)
// that is `open`, which restarts or resumes the connection; with arguments it
// forwards them (launchd passes `daemon`). The runtime stays a child process, so
// macOS attributes every permission prompt to this app: its name and icon.
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
static pid_t child = 0;

static void forward(int signal) {
  if (child > 0) kill(child, signal);
}

int main(int argc, char **argv) {
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0) return 70;
  char resolved[PATH_MAX];
  if (!realpath(executable, resolved)) return 70;
  char *dir = dirname(resolved);
  char node[PATH_MAX], cli[PATH_MAX];
  snprintf(node, sizeof(node), "%s/shapes.inc Bridge Runtime", dir);
  snprintf(cli, sizeof(cli), "%s/../Resources/runtime/bin/cli.js", dir);

  // Older local control scripts pass the CLI path themselves; drop it so the
  // same bundle works for them. Finder may pass a legacy -psn argument.
  int first = 1;
  if (first < argc) {
    size_t length = strlen(argv[first]);
    if (length >= 6 && strcmp(argv[first] + length - 6, "cli.js") == 0) first++;
  }
  if (first < argc && strncmp(argv[first], "-psn", 4) == 0) first++;
  int forwarded = argc - first;
  char **args = calloc((size_t)forwarded + 4, sizeof(char *));
  if (!args) return 71;
  args[0] = node;
  args[1] = cli;
  if (forwarded > 0) memcpy(args + 2, argv + first, (size_t)forwarded * sizeof(char *));
  else args[2] = "open";

  signal(SIGTERM, forward);
  signal(SIGINT, forward);
  signal(SIGHUP, forward);
  if (posix_spawn(&child, node, NULL, NULL, args, environ) != 0) {
    perror("shapes.inc Bridge: could not start its runtime");
    return 72;
  }
  int status = 0;
  while (waitpid(child, &status, 0) < 0) { /* interrupted by a forwarded signal */ }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) { signal(WTERMSIG(status), SIG_DFL); raise(WTERMSIG(status)); }
  return 1;
}
