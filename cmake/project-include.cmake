# Included by the toolchain file and, via CMAKE_PROJECT_INCLUDE, after every project(): everything built with
# wasm-build-all is wasm64, whatever CMAKE_C_FLAGS the project uses.
set(CMAKE_SIZEOF_VOID_P 8)
set(CMAKE_C_SIZEOF_DATA_PTR 8)
set(CMAKE_CXX_SIZEOF_DATA_PTR 8)
set(CMAKE_LIBRARY_ARCHITECTURE "wasm64-emscripten")
set(CMAKE_SYSTEM_PROCESSOR wasm64)
