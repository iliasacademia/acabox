# Window Monitor
# Makefile for building the window monitoring tool (macOS)

# Compiler settings
CXX = clang++
CXXFLAGS = -std=c++17 -fobjc-arc -ObjC++ -Wall -Wextra -O2
LDFLAGS = -framework Foundation \
          -framework AppKit \
          -framework ApplicationServices \
          -framework CoreGraphics

# Target
TARGET = window-monitor

# Source directory
SRCDIR = macos

# Source files
SOURCES = $(SRCDIR)/main.mm \
          $(SRCDIR)/WindowMonitor.mm \
          $(SRCDIR)/WindowInfo.mm

# Object files
OBJECTS = $(SOURCES:.mm=.o)

# Default target
all: $(TARGET)

# Link
$(TARGET): $(OBJECTS)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -o $@ $^

# Compile
$(SRCDIR)/%.o: $(SRCDIR)/%.mm
	$(CXX) $(CXXFLAGS) -I$(SRCDIR) -c -o $@ $<

# Clean
clean:
	rm -f $(TARGET) $(OBJECTS) $(SRCDIR)/*.o

# Run
run: $(TARGET)
	./$(TARGET)

# Debug build
debug: CXXFLAGS += -g -DDEBUG
debug: clean all

# Help
help:
	@echo "Available targets:"
	@echo "  all     - Build the window monitor (default)"
	@echo "  clean   - Remove built files"
	@echo "  run     - Build and run the monitor"
	@echo "  debug   - Build with debug symbols"
	@echo "  help    - Show this help message"

.PHONY: all clean run debug help
