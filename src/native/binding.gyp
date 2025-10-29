{
  "targets": [
    {
      "target_name": "word_accessibility",
      "sources": [
        "bridge.mm",
        "bridge/interface/Message.cpp",
        "bridge/interface/MessageRouter.cpp",
        "bridge/factory/BridgeFactory.cpp",
        "bridge/helpers/ScriptInjector.mm",
        "bridge/helpers/HTMLLoader.mm",
        "bridge/helpers/PanelStyleHelper.mm",
        "bridge/helpers/WebViewConfigHelper.mm",
        "bridge/windows/BasePopupWindow.mm",
        "bridge/windows/BaseNativeWindow.mm",
        "bridge/windows/TextPopupWindow.mm",
        "bridge/windows/ClickPopupWindow.mm",
        "bridge/windows/ButtonOverlayWindow.mm",
        "bridge/windows/LineCountButtonWindow.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "bridge/interface",
        "bridge/macos",
        "bridge/factory",
        "bridge/helpers",
        "bridge/windows"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "conditions": [
        [
          "OS=='mac'",
          {
            "sources": [
              "bridge/macos/MacOSWebViewBridge.mm"
            ],
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_CXX_LIBRARY": "libc++",
              "MACOSX_DEPLOYMENT_TARGET": "10.15",
              "OTHER_CFLAGS": [
                "-fobjc-arc",
                "-ObjC++"
              ],
              "OTHER_LDFLAGS": [
                "-framework ApplicationServices",
                "-framework Cocoa",
                "-framework CoreGraphics",
                "-framework WebKit"
              ]
            },
            "link_settings": {
              "libraries": [
                "-framework ApplicationServices",
                "-framework Cocoa",
                "-framework CoreGraphics",
                "-framework WebKit"
              ]
            }
          }
        ],
        [
          "OS=='win'",
          {
            "sources": [
              "bridge/windows/WindowsWebViewBridge.cpp"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              }
            }
          }
        ]
      ]
    }
  ]
}
