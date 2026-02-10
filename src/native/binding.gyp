{
  "targets": [
    {
      "target_name": "word_accessibility",
      "sources": [
        "bridge.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
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
                "-framework CoreGraphics"
              ]
            },
            "link_settings": {
              "libraries": [
                "-framework ApplicationServices",
                "-framework Cocoa",
                "-framework CoreGraphics"
              ]
            }
          }
        ]
      ]
    }
  ]
}
