cmake_minimum_required(VERSION 3.15)
project(prusa_fdm_mixer CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# The library: a single TU. Vendor it directly into your slicer source tree
# or consume it via add_subdirectory().
add_library(filament_mix STATIC filament_mix.cpp)
target_include_directories(filament_mix PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>
)
target_compile_options(filament_mix PRIVATE
  -Wall -Wextra -Wpedantic
  $<$<CXX_COMPILER_ID:GNU,Clang>:-Wshadow -Wconversion -Wsign-conversion -Wold-style-cast>
)

# Test executable.
option(FILAMENT_MIX_BUILD_TESTS "Build the filament_mix test suite" ON)
if(FILAMENT_MIX_BUILD_TESTS)
  enable_testing()
  add_executable(test_filament_mix test_filament_mix.cpp)
  target_link_libraries(test_filament_mix PRIVATE filament_mix)
  add_test(NAME unit COMMAND test_filament_mix)
endif()
