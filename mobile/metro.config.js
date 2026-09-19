const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// react-native-filament loads the car as a .glb — Metro needs to treat it as
// a binary asset, same as a .png, rather than trying to parse it as source.
config.resolver.assetExts = [...config.resolver.assetExts, 'glb'];

module.exports = withNativeWind(config, { input: './global.css' });
