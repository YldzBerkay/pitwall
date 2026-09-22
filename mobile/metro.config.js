const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../shared');

const config = getDefaultConfig(projectRoot);

// react-native-filament loads the car as a .glb — Metro needs to treat it as
// a binary asset, same as a .png, rather than trying to parse it as source.
config.resolver.assetExts = [...config.resolver.assetExts, 'glb'];

// `@pitwall/shared` proje kökünün DIŞINDA yaşıyor. Metro varsayılan olarak
// yalnızca projectRoot altını izler; watchFolders olmadan paketin dosyaları
// "bulunamadı" hatası verir. nodeModulesPaths ikisini de listeler ki paketin
// kendi bağımlılıkları (yok, ama ileride olursa) da çözülebilsin.
config.watchFolders = [sharedRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(sharedRoot, 'node_modules'),
];
config.resolver.unstable_enableSymlinks = true;

module.exports = withNativeWind(config, { input: './global.css' });
