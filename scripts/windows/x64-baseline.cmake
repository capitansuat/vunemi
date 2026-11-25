# Windows x64, built on the ARM64 machine with the same clang. The CPU
# features come from ggml's own non-native defaults (SSE4.2, AVX2, FMA, F16C,
# BMI2; no AVX-512), which nearly every x64 PC since 2013 has and Windows on
# ARM's emulator runs, so the build can be tried there.
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR AMD64)
set(target x86_64-pc-windows-msvc)
set(CMAKE_C_COMPILER clang)
set(CMAKE_CXX_COMPILER clang++)
set(CMAKE_C_COMPILER_TARGET ${target})
set(CMAKE_CXX_COMPILER_TARGET ${target})
set(CMAKE_ASM_COMPILER_TARGET ${target})
set(warn_c_flags "-Wno-format -Wno-unused-variable -Wno-unused-function -Wno-gnu-zero-variadic-macro-arguments")
set(CMAKE_C_FLAGS_INIT "${warn_c_flags}")
set(CMAKE_CXX_FLAGS_INIT "${warn_c_flags}")
