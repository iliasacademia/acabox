#pragma once

#include "../interface/IWebViewBridge.h"
#include <memory>
#include <string>

namespace AcademiaBridge {

/**
 * BridgeFactory - Creates platform-specific bridge instances
 *
 * Uses compile-time platform detection to instantiate the appropriate
 * bridge implementation (macOS, Windows, etc.)
 */
class BridgeFactory {
public:
    /**
     * Create a new bridge instance for the current platform
     * @return shared pointer to platform-specific bridge
     */
    static std::shared_ptr<IWebViewBridge> createBridge();

    /**
     * Get the current platform name
     * @return platform name string ("macOS", "Windows", "Linux", "Unknown")
     */
    static std::string getPlatformName();

    /**
     * Check if current platform is supported
     * @return true if platform has bridge implementation
     */
    static bool isPlatformSupported();
};

} // namespace AcademiaBridge
