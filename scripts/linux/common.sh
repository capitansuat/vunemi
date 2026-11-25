# Shared by build-engine-linux.sh and build-whisper-linux.sh: the target
# architecture, its CMake settings, and the checks every binary passes before
# it is packed.

# --arch x64|arm64 (default: this machine's). Sets arch, cmake_arch_args, strip_tool, elf_machine.
linux_target() {
  local want="${1:-}"
  if [ -z "$want" ]; then
    case "$(uname -m)" in x86_64) want=x64 ;; aarch64 | arm64) want=arm64 ;; *) echo "! desteklenmeyen mimari: $(uname -m)" >&2; exit 1 ;; esac
  fi
  arch="$want"
  case "$arch" in
    x64)
      elf_machine="Advanced Micro Devices X86-64"
      if [ "$(uname -m)" = "x86_64" ]; then
        cmake_arch_args=(); strip_tool=strip
      else
        cmake_arch_args=(-DCMAKE_TOOLCHAIN_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/x64-baseline.cmake"); strip_tool=x86_64-linux-gnu-strip
      fi ;;
    arm64)
      # Every 64-bit ARM Linux CPU in use has armv8.2 + dotprod + fp16 (the Windows arm64 build's baseline);
      # llama.cpp's newer defaults die with an illegal instruction on CPUs without I8MM/BF16 (an M1 in a VM).
      elf_machine="AArch64"
      [ "$(uname -m)" = "aarch64" ] || { echo "! arm64 yalnızca arm64 bir makinede derlenir" >&2; exit 1; }
      cmake_arch_args=(-DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16); strip_tool=strip ;;
    *) echo "! --arch x64 ya da --arch arm64" >&2; exit 1 ;;
  esac
}

# The binary is for the target machine, needs only glibc's own libraries, and holds no builder path.
check_linux_binary() {
  local bin="$1" name="$2"
  if ! readelf -h "$bin" | grep -q "Machine:.*$elf_machine"; then
    readelf -h "$bin" | grep Machine
    echo "! $name $arch için değil"; exit 1
  fi
  if readelf -d "$bin" | grep NEEDED | grep -Ev '\[(libc|libm|libpthread|libdl|librt)\.so\.[0-9]+\]|\[ld-linux[^]]*\]' | grep -q .; then
    readelf -d "$bin" | grep NEEDED
    echo "! $name glibc dışı bir kütüphaneye bağlı"; exit 1
  fi
  if grep -q -a -F "$HOME/" "$bin"; then
    echo "! $name derleme yolunu (kullanıcı klasörü) içeriyor"; exit 1
  fi
}
