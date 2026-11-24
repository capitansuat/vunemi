# Windows on ARM, for a baseline every Windows ARM PC has (armv8.2 + dotprod +
# fp16). llama.cpp's own arm64-windows-llvm.cmake targets armv8.7, and its
# engine died with an illegal instruction on CPUs without I8MM/BF16 (an Apple
# M1 under UTM, older Snapdragons).
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR arm64)
set(target arm64-pc-windows-msvc)
set(CMAKE_C_COMPILER clang)
set(CMAKE_CXX_COMPILER clang++)
set(CMAKE_C_COMPILER_TARGET ${target})
set(CMAKE_CXX_COMPILER_TARGET ${target})
set(CMAKE_ASM_COMPILER_TARGET ${target})
set(arch_c_flags "-march=armv8.2-a+dotprod+fp16 -fvectorize -ffp-model=fast -fno-finite-math-only")
set(warn_c_flags "-Wno-format -Wno-unused-variable -Wno-unused-function -Wno-gnu-zero-variadic-macro-arguments")
set(CMAKE_C_FLAGS_INIT "${arch_c_flags} ${warn_c_flags}")
set(CMAKE_CXX_FLAGS_INIT "${arch_c_flags} ${warn_c_flags}")
