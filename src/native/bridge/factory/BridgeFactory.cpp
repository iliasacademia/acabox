#include "BridgeFactory.h"
#include <iostream>

// Include platform-specific bridge implementations
#ifdef __APPLE__
    #include "../macos/MacOSWebViewBridge.h"
#elif defined(_WIN32)
    // #include "../windows/WindowsWebViewBridge.h"
    // TODO: Implement Windows bridge
#endif

namespace AcademiaBridge {

std::shared_ptr<IWebViewBridge> BridgeFactory::createBridge() {
#ifdef __APPLE__
    std::cout << "[BridgeFactory] Creating macOS bridge" << std::endl;
    return std::make_shared<MacOSWebViewBridge>();
#elif defined(_WIN32)
    std::cerr << "[BridgeFactory] Windows bridge not yet implemented" << std::endl;
    // return std::make_shared<WindowsWebViewBridge>();
    return nullptr;
#else
    std::cerr << "[BridgeFactory] Unsupported platform" << std::endl;
    return nullptr;
#endif
}

std::string BridgeFactory::getPlatformName() {
#ifdef __APPLE__
    return "macOS";
#elif defined(_WIN32)
    return "Windows";
#elif defined(__linux__)
    return "Linux";
#else
    return "Unknown";
#endif
}

bool BridgeFactory::isPlatformSupported() {
#if defined(__APPLE__)
    return true;
#elif defined(_WIN32)
    // return true; // Enable when Windows bridge is implemented
    return false;
#else
    return false;
#endif
}

} // namespace AcademiaBridge
