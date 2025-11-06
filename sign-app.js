const sign = require('@electron/osx-sign');

sign.sign({
  app: 'out/academia-electron-darwin-arm64/academia-electron.app',
  identity: '6FF117CBEA6E11B14B2CCCD15B306E760831800F',
  hardenedRuntime: true,
  entitlements: 'entitlements.plist',
  'entitlements-inherit': 'entitlements.plist',
}, function (err) {
  if (err) {
    console.error('Signing failed:', err);
  } else {
    console.log('App signed successfully!');
  }
});
