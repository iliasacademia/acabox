# Critical Native Tests

This directory contains critical unit tests for the native Objective-C++ bridge code.

## Test Coverage

The critical tests cover:

### 1. Window Initialization (6 tests)
- ✅ TextPopupWindow initialization doesn't crash
- ✅ ClickPopupWindow initialization doesn't crash
- ✅ ButtonOverlayWindow initialization doesn't crash
- ✅ LineCountButtonWindow initialization doesn't crash
- ✅ BasePopupWindow initialization doesn't crash
- ✅ Window initialization with nil observer

### 2. Content Updates (1 test)
- ✅ TextPopupWindow content updates correctly

### 3. Window Positioning (1 test)
- ✅ Button overlay positions at point correctly

### 4. Schedule/Cancel Operations (1 test)
- ✅ Schedule and cancel hide operations work

### 5. Memory Management (1 test)
- ✅ Windows deallocate properly (with WKWebView async caveat)

**Total: 10 critical tests**

## Running Tests

### Method 1: From project root (Recommended)

```bash
npm run test:native
```

### Method 2: Directly from native directory

```bash
cd src/native
./run-simple-tests.sh
```

## Test Output

Successful run:
```
======================================
Running Critical Native Tests (Simple)
======================================

Step 1: Compiling test executable...
✓ Compilation successful

Step 2: Running tests...

[TEST] Starting: TextPopupWindow Initialization
  ✓ PASSED

[TEST] Starting: ClickPopupWindow Initialization
  ✓ PASSED

... (8 more tests)

======================================
Test Results: 10/10 passed
======================================
✓ All tests passed!
```

## Requirements

- macOS 10.15+
- Xcode Command Line Tools (no full Xcode required)
- Node.js (for npm scripts)

## Debugging Failed Tests

If a test fails:

1. **Check the error message** - Tests output detailed assertion failures
2. **Run tests directly** to see all output:
   ```bash
   cd src/native
   ./run-simple-tests.sh
   ```
3. **Check the test code** in `bridge/__tests__/SimpleTests.mm`

## Common Issues

### Issue: "Could not find popup HTML file"
**Solution**: This is expected in test environment - tests don't require actual HTML files

### Issue: "WKWebView async cleanup"
**Solution**: This is normal WebKit behavior - not a memory leak

### Issue: Compilation errors
**Solution**: Make sure all source files exist and Xcode Command Line Tools are installed

### Issue: Tests timeout or hang
**Solution**: Check for infinite loops or missing NSRunLoop processing

## Adding New Tests

To add a new critical test:

1. Add test function to `SimpleTests.mm`:
   ```objc
   void testMyNewFeature() {
       TEST_START("My New Feature");

       @autoreleasepool {
           MyWindow* window = [[MyWindow alloc] init];
           [window doSomething];

           ASSERT_NOT_NULL(window.result, "Result should exist");
           TEST_PASS();
       }
   }
   ```

2. Add function call in `main()`:
   ```objc
   testMyNewFeature();
   ```

3. Run tests to verify:
   ```bash
   ./run-simple-tests.sh
   ```

## CI Integration

To run in CI/CD:

```yaml
# .github/workflows/test.yml
- name: Run Critical Native Tests
  run: npm run test:native
```

## Test Framework

These tests use a **simple custom framework** instead of XCTest because:
- ✅ Works with just Command Line Tools (no full Xcode needed)
- ✅ Faster compilation and execution
- ✅ Clear, readable output
- ✅ Easy to add new tests
- ✅ No external dependencies

## Test Philosophy

These are **critical** tests focused on:
- **Safety**: No crashes or undefined behavior
- **Correctness**: Core functionality works as expected
- **Memory Safety**: Windows deallocate properly
- **Robustness**: Edge cases are handled gracefully

Non-critical tests (performance, UI appearance, bridge communication) are intentionally excluded to keep the suite fast and focused on preventing crashes.
