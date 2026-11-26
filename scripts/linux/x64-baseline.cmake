# Linux x64, built on the arm64 Linux machine with Ubuntu's cross compiler
# (gcc-x86-64-linux-gnu). The CPU features come from ggml's own non-native
# defaults (SSE4.2, AVX2, FMA, F16C, BMI2; no AVX-512), the same baseline as
# the Windows x64 build: nearly every x64 PC since 2013, and Rosetta, run it.
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER x86_64-linux-gnu-gcc)
set(CMAKE_CXX_COMPILER x86_64-linux-gnu-g++)
set(CMAKE_FIND_ROOT_PATH /usr/x86_64-linux-gnu)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
