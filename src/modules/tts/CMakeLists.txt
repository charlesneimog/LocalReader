cmake_minimum_required(VERSION 3.26)
project(ttspiper LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ------------------------------------------------------------------
# Dependencies (same as your original, trimmed for clarity)
# ------------------------------------------------------------------
include(ExternalProject)

set(CPM_FILE ${CMAKE_BINARY_DIR}/CPM.cmake)
set(CPM_VERSION "0.42.0")
if(NOT EXISTS "${CPM_FILE}")
  file(
    DOWNLOAD
    "https://github.com/cpm-cmake/CPM.cmake/releases/download/v${CPM_VERSION}/CPM.cmake"
    ${CPM_FILE}
    SHOW_PROGRESS)
endif()
include(${CPM_FILE})

# libpiper
cpmaddpackage(
  NAME
  libpiper
  GITHUB_REPOSITORY
  OHF-Voice/piper1-gpl
  GIT_TAG
  main
  DOWNLOAD_ONLY
  YES)

# espeak-ng
cpmaddpackage(
  NAME
  espeak-ng
  GITHUB_REPOSITORY
  espeak-ng/espeak-ng
  GIT_TAG
  master
  OPTIONS
  "ENABLE_TESTS OFF"
  "USE_ASYNC OFF"
  "USE_MBROLA OFF"
  "USE_LIBSONIC OFF"
  "USE_LIBPCAUDIO OFF"
  "USE_KLATT OFF"
  "USE_SPEECHPLAYER OFF"
  "EXTRA_cmn ON"
  "EXTRA_ru ON")

if(espeak-ng_ADDED)
  file(REMOVE "${espeak-ng_SOURCE_DIR}/src/include/compat/wctype.h")
endif()

# ONNX Runtime (imported pre-built WASM static library)
if(NOT ONNXRUNTIME_WEBASSEMBLY_STATICLIBRARY)
  message(FATAL_ERROR "Provide ONNXRUNTIME_WEBASSEMBLY_STATICLIBRARY")
endif()
add_library(onnxruntime STATIC IMPORTED GLOBAL)
set_target_properties(
  onnxruntime PROPERTIES IMPORTED_LOCATION
                         ${ONNXRUNTIME_WEBASSEMBLY_STATICLIBRARY})

if(NOT ONNXRUNTIME_WEBASSEMBLY_INCLUDE)
  message(FATAL_ERROR "Provide ONNXRUNTIME_WEBASSEMBLY_INCLUDE")
endif()
include_directories(${ONNXRUNTIME_WEBASSEMBLY_INCLUDE})

# ------------------------------------------------------------------
# Piper static wrapper (just piper.cpp for core)
# ------------------------------------------------------------------
add_library(piper STATIC ${libpiper_SOURCE_DIR}/libpiper/src/piper.cpp)
target_include_directories(
  piper
  PUBLIC ${ONNXRUNTIME_WEBASSEMBLY_INCLUDE}
         ${libpiper_SOURCE_DIR}/libpiper/include
         ${espeak-ng_SOURCE_DIR}/src/include)

# ------------------------------------------------------------------
# WASM executable
# ------------------------------------------------------------------
add_executable(pipertts piper-tts.cpp)

target_link_libraries(pipertts PRIVATE piper espeak-ng onnxruntime embind)

# Emscripten link flags - We keep filesystem, allow growth, preload espeak-ng
# data.
target_link_options(
  pipertts
  PRIVATE
  "-sMODULARIZE=1"
  "-sEXPORT_NAME=PiperTTS"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sINITIAL_MEMORY=512MB"
  "-sSTACK_SIZE=64MB"             
  "-sASSERTIONS=2"
  "-sFORCE_FILESYSTEM=1"
  "-sNO_DISABLE_EXCEPTION_CATCHING"
  "-sEXPORTED_RUNTIME_METHODS=['FS','ccall','cwrap']"
  "--preload-file=/home/neimog/Downloads/espeak-ng/build/espeak-ng-data@/espeak-ng-data"
)
# (Optional) Optimize for release: set_target_properties(pipertts PROPERTIES
# COMPILE_OPTIONS "-O3" LINK_OPTIONS "-O3")
