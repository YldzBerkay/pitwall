module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    plugins: [
      // react-native-filament's worklet runtime (separate from Reanimated's).
      ['react-native-worklets-core/plugin', { processNestedWorklets: true }],
      // react-native-worklets/plugin must be listed last (Reanimated v4).
      'react-native-worklets/plugin',
    ],
  };
};
