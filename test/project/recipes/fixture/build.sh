# Test fixture: exercises the ctest runners under node and in the browsers.
build() {
  wba_cmake
}
test() {
  wba_ctest upstream
  wba_browser_ctest upstream --jobs 2
}
